using System.Text.Json.Nodes;
using Koc.Dwos.Api.Hubs;
using Koc.Dwos.Api.Services;
using Koc.Dwos.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Koc.Dwos.Api.Controllers;

/// <summary>
/// Supervisor movement plans. Routes and shapes mirror the Node server.
/// </summary>
[ApiController]
[Route("api/movement-plans")]
public class MovementPlansController(DwoDbContext db, ReportWriter writer, IHubContext<LiveHub> hub) : ControllerBase
{
    /// <summary>Index of every plan. Mirrors data/movement-plans/index.json.</summary>
    [HttpGet]
    public async Task<IActionResult> GetIndex(CancellationToken ct)
    {
        var rows = await db.MovementPlans
            .Where(p => !p.IsDeleted)
            .OrderBy(p => p.PlanDate)
            .Select(p => new
            {
                plan_date = p.PlanDate.ToString("yyyy-MM-dd"),
                issued_date = p.IssuedDate == null ? null : p.IssuedDate.Value.ToString("yyyy-MM-dd"),
                issued_by = p.IssuedBy,
                subject = p.Subject,
                vessels = p.Vessels.OrderBy(v => v.SortOrder).Select(v => v.Vessel!.VesselCode).ToList(),
                source_type = p.SourceType,
                file = "movement-plans/" + p.PlanDate.ToString("yyyy-MM-dd") + ".json",
            })
            .ToListAsync(ct);

        return Ok(new { plans = rows });
    }

    [HttpGet("{date}")]
    public async Task<IActionResult> GetOne(string date, CancellationToken ct)
    {
        if (!DateOnly.TryParse(date, out var d))
            return BadRequest(new { error = "date must be YYYY-MM-DD" });

        var raw = await db.MovementPlans
            .Where(p => p.PlanDate == d && !p.IsDeleted)
            .Select(p => p.RawJson)
            .FirstOrDefaultAsync(ct);

        if (raw is null) return NotFound(new { error = "no plan for that date" });
        return Content(raw, "application/json");
    }

    /// <summary>
    /// The structured plans the map animates: snapshots and legs, keyed by date.
    /// This is what data/plans.json held, served from the database.
    /// </summary>
    [HttpGet("structured")]
    public async Task<IActionResult> GetStructured(CancellationToken ct)
    {
        var plans = await db.MovementPlans
            .Where(p => !p.IsDeleted && (p.Snapshots.Any() || p.Legs.Any()))
            .OrderBy(p => p.PlanDate)
            .Select(p => new
            {
                plan_date = p.PlanDate.ToString("yyyy-MM-dd"),
                snapshot_at = p.SnapshotAt,
                snapshots = p.Snapshots.Select(s => new
                {
                    vessel_id = s.Vessel!.VesselCode,
                    loc = s.MarineLocation!.LocationCode,
                    raw = s.RawText,
                }).ToList(),
                movements = p.Legs.OrderBy(l => l.SortOrder).Select(l => new
                {
                    id = l.Id,
                    parent_id = l.ParentLegId,
                    vessel = l.Vessel!.VesselCode,
                    leg_type = l.LegType,
                    etd = l.Etd,
                    eta = l.Eta,
                    from = l.FromLocation!.LocationCode,
                    to = l.ToLocation!.LocationCode,
                    via = l.ViaJson,
                    purpose = l.Purpose,
                    raw = l.RawText,
                    etd_uncertain = l.EtdUncertain,
                    etd_source = l.EtdSource,
                }).ToList(),
            })
            .ToListAsync(ct);

        return Ok(new { plans });
    }

    [HttpPost]
    public async Task<IActionResult> Save([FromBody] JsonNode? body, CancellationToken ct)
    {
        if (body is null) return BadRequest(new { error = "invalid JSON" });

        body["source"] = ReportsController.MergeSource(body["source"], "dashboard_submission", "client");

        var (ok, error) = await writer.SavePlanAsync(body, ct);
        if (!ok) return BadRequest(new { error });

        var planDate = body["plan_date"]!.GetValue<string>();
        await hub.Clients.All.SendAsync(LiveEvents.PlanSaved, new { plan_date = planDate }, ct);

        return Ok(new { ok = true, plan_date = planDate });
    }
}
