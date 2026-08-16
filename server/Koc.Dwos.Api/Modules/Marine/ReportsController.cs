using System.Text.Json.Nodes;
using Koc.Dwos.Api.Hubs;
using Koc.Dwos.Api.Services;
using Koc.Dwos.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Koc.Dwos.Api.Controllers;

/// <summary>
/// Daily vessel reports.
///
/// The routes and response shapes match the Node server they replace, so the
/// existing vanilla frontend can be pointed at this API unchanged. That is the
/// checkpoint that proves parity before any UI is rewritten - if the old client
/// works against the new backend, the backend is done.
/// </summary>
[ApiController]
[Route("api/reports")]
public class ReportsController(DwoDbContext db, ReportWriter writer, IHubContext<LiveHub> hub) : ControllerBase
{
    /// <summary>Index of every report. Mirrors data/daily-reports/index.json.</summary>
    [HttpGet]
    public async Task<IActionResult> GetIndex(CancellationToken ct)
    {
        var rows = await db.VesselDailyReports
            .Where(r => !r.IsDeleted)
            .OrderBy(r => r.ReportDate).ThenBy(r => r.Vessel!.VesselCode)
            .Select(r => new
            {
                vessel_id = r.Vessel!.VesselCode,
                report_date = r.ReportDate.ToString("yyyy-MM-dd"),
                // Kept for compatibility: the old client uses this to build a
                // fallback fetch path when it cannot reach the API.
                file = "daily-reports/" + r.Vessel.VesselCode + "-" + r.ReportDate.ToString("yyyy-MM-dd") + ".json",
                task_log_rows = r.Tasks.Count,
                source_type = r.SourceType,
            })
            .ToListAsync(ct);

        return Ok(new { reports = rows });
    }

    /// <summary>One report, in the exact shape it was submitted or imported.</summary>
    [HttpGet("{vesselCode}/{date}")]
    public async Task<IActionResult> GetOne(string vesselCode, string date, CancellationToken ct)
    {
        if (!DateOnly.TryParse(date, out var d))
            return BadRequest(new { error = "date must be YYYY-MM-DD" });

        if (!await db.Vessels.AnyAsync(v => v.VesselCode == vesselCode, ct))
            return BadRequest(new { error = "unknown vessel_id" });

        var raw = await db.VesselDailyReports
            .Where(r => r.Vessel!.VesselCode == vesselCode && r.ReportDate == d && !r.IsDeleted)
            .Select(r => r.RawJson)
            .FirstOrDefaultAsync(ct);

        if (raw is null) return NotFound(new { error = "not found" });

        // Returned verbatim rather than re-serialised from columns: the payload
        // carries fields no column has, and the old client expects all of them.
        return Content(raw, "application/json");
    }

    [HttpPost]
    public async Task<IActionResult> Save([FromBody] JsonNode? body, CancellationToken ct)
    {
        if (body is null) return BadRequest(new { error = "invalid JSON" });

        body["source"] = MergeSource(body["source"], "dashboard_submission", "client");

        var (ok, error) = await writer.SaveReportAsync(body, ct);
        if (!ok) return BadRequest(new { error });

        var vesselId = body["vessel_id"]!.GetValue<string>();
        var reportDate = body["report_date"]!.GetValue<string>();

        await hub.Clients.All.SendAsync(LiveEvents.ReportSaved,
            new { vessel_id = vesselId, report_date = reportDate }, ct);

        return Ok(new { ok = true, vessel_id = vesselId, report_date = reportDate });
    }

    internal static JsonObject MergeSource(JsonNode? existing, string type, string via)
    {
        // Preserve whatever provenance the caller sent (an import carries the
        // email headers) and stamp how it reached us on top.
        var src = existing is JsonObject o ? o.DeepClone().AsObject() : new JsonObject();
        src["type"] = type;
        src["submitted_via"] = via;
        src["submitted_at"] = DateTime.UtcNow.ToString("O");
        return src;
    }
}
