using System.Diagnostics;
using System.Text.Json.Nodes;
using Koc.Vessels.Api.Hubs;
using Koc.Vessels.Api.Services;
using Koc.Vessels.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Koc.Vessels.Api.Controllers;

/// <summary>
/// Bulk PDF import of daily vessel reports — the drag-and-drop card on the
/// Forms page. Request/response contract matches the Node server it replaces:
///   POST /api/import  { files: [{ name, data_base64 }] }
///   →  { results: [{ name, vessel_id?, report_date?, rows?, status, reason? }], saved }
///
/// Parsing stays in the proven Python/pdfplumber tools (250+ real PDFs); this
/// controller is only the bridge: temp file → parser process → validated JSON →
/// ReportWriter. A C# PDF parser would be a rewrite of battle-tested logic for
/// no user-visible gain.
/// </summary>
[ApiController]
[Route("api/import")]
public class ImportController(
    DwoDbContext db, ReportWriter writer, IHubContext<LiveHub> hub,
    ILogger<ImportController> logger) : ControllerBase
{
    public record ImportFile(string? name, string? data_base64);
    public record ImportRequest(List<ImportFile>? files);

    [HttpPost]
    [RequestSizeLimit(32 * 1024 * 1024)]
    public async Task<IActionResult> Import([FromBody] ImportRequest? body, CancellationToken ct)
    {
        var files = body?.files ?? [];
        if (files.Count == 0) return BadRequest(new { error = "no files provided" });

        var (toolsRoot, python) = LocateTools();
        if (toolsRoot is null)
            return StatusCode(500, new { error = "PDF parser not found: tools/parse_daily_reports.py is not on this machine" });

        var tmpDir = Directory.CreateTempSubdirectory("koc-import-").FullName;
        var results = new List<object>();
        var seenInBatch = new Dictionary<string, string>();   // "vid|date" -> first filename that won it
        var savedKeys = new List<(string VesselId, string ReportDate)>();

        try
        {
            foreach (var f in files)
            {
                var name = string.IsNullOrWhiteSpace(f.name) ? "upload.pdf" : f.name!;
                if (!name.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
                {
                    results.Add(new { name, status = "skipped", reason = "not a PDF" });
                    continue;
                }

                byte[] buf;
                try { buf = Convert.FromBase64String(f.data_base64 ?? ""); }
                catch { results.Add(new { name, status = "error", reason = "could not decode file" }); continue; }
                if (buf.Length == 0) { results.Add(new { name, status = "error", reason = "empty file" }); continue; }

                var tmpPath = Path.Combine(tmpDir, $"{Guid.NewGuid()}.pdf");
                await System.IO.File.WriteAllBytesAsync(tmpPath, buf, ct);

                var parsed = await ParsePdfAsync(python!, toolsRoot, tmpPath, name, ct);
                if (parsed?["ok"]?.GetValue<bool>() != true)
                {
                    results.Add(new { name, status = "error", reason = parsed?["error"]?.GetValue<string>() ?? "parse failed" });
                    continue;
                }

                var rec = parsed["record"];
                var vesselId = rec?["vessel_id"]?.GetValue<string>();
                var reportDate = rec?["report_date"]?.GetValue<string>();
                var rows = rec?["task_log"]?.AsArray().Count ?? 0;
                if (rec is null || vesselId is null || reportDate is null)
                {
                    results.Add(new { name, status = "error", reason = "parser returned an incomplete record" });
                    continue;
                }

                var key = $"{vesselId}|{reportDate}";
                if (seenInBatch.TryGetValue(key, out var winner))
                {
                    results.Add(new { name, vessel_id = vesselId, report_date = reportDate, rows,
                                      status = "skipped", reason = $"same vessel/date as {winner}" });
                    continue;
                }
                seenInBatch[key] = name;

                var date = DateOnly.Parse(reportDate);
                var existed = await db.VesselDailyReports
                    .AnyAsync(r => r.Vessel!.VesselCode == vesselId && r.ReportDate == date, ct);

                // The parser record carries its own source{} (email headers when
                // known); stamp how it reached us on top, like the old server did.
                rec["source"] = ReportsController.MergeSource(rec["source"], "imported_pdf", "forms_import");

                var (ok, error) = await writer.SaveReportAsync(rec.DeepClone(), ct);
                if (!ok)
                {
                    results.Add(new { name, vessel_id = vesselId, report_date = reportDate, rows,
                                      status = "error", reason = error });
                    continue;
                }

                savedKeys.Add((vesselId, reportDate));
                results.Add(new { name, vessel_id = vesselId, report_date = reportDate, rows,
                                  status = existed ? "overwrote" : "saved" });
            }
        }
        finally
        {
            try { Directory.Delete(tmpDir, recursive: true); } catch { /* temp cleanup is best-effort */ }
        }

        foreach (var (vid, date) in savedKeys)
        {
            await hub.Clients.All.SendAsync(LiveEvents.ReportSaved,
                new { vessel_id = vid, report_date = date }, ct);
        }

        return Ok(new { results, saved = savedKeys.Count });
    }

    /// <summary>
    /// Finds the repo root (the directory holding tools/parse_daily_reports.py)
    /// by walking up from the app, and picks the project venv's python when it
    /// exists — pdfplumber lives there, not in the system python (PEP 668).
    /// </summary>
    private static (string? toolsRoot, string? python) LocateTools()
    {
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 8 && dir is not null; i++)
        {
            if (System.IO.File.Exists(Path.Combine(dir, "tools", "parse_daily_reports.py")))
            {
                var venv = Path.Combine(dir, ".venv", "bin", "python3");
                return (dir, System.IO.File.Exists(venv) ? venv : "python3");
            }
            dir = Directory.GetParent(dir)?.FullName;
        }
        return (null, null);
    }

    private async Task<JsonNode?> ParsePdfAsync(
        string python, string root, string pdfPath, string originalName, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = python,
            WorkingDirectory = root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add(Path.Combine(root, "tools", "parse_daily_reports.py"));
        psi.ArgumentList.Add("--pdf");
        psi.ArgumentList.Add(pdfPath);
        psi.ArgumentList.Add("--name");
        psi.ArgumentList.Add(originalName);

        using var proc = Process.Start(psi);
        if (proc is null) return null;

        var stdout = await proc.StandardOutput.ReadToEndAsync(ct);
        var stderr = await proc.StandardError.ReadToEndAsync(ct);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(60));
        try { await proc.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { }
            return JsonNode.Parse("""{"ok":false,"error":"parser timed out after 60s"}""");
        }

        // The envelope is the last non-empty line of stdout.
        var line = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).LastOrDefault()?.Trim();
        if (string.IsNullOrEmpty(line))
        {
            var reason = string.IsNullOrWhiteSpace(stderr) ? "parser produced no output" : stderr.Trim();
            logger.LogWarning("PDF parser failed for {Name}: {Reason}", originalName, reason);
            return JsonNode.Parse($$"""{"ok":false,"error":{{System.Text.Json.JsonSerializer.Serialize(reason)}}}""");
        }
        try { return JsonNode.Parse(line); }
        catch
        {
            logger.LogWarning("PDF parser returned non-JSON for {Name}", originalName);
            return JsonNode.Parse("""{"ok":false,"error":"could not read the parser output"}""");
        }
    }
}
