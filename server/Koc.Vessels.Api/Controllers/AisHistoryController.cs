using Koc.Vessels.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Koc.Vessels.Api.Controllers;

/// <summary>
/// Imported AIS tracks. Routes and shapes mirror the Node server.
///
/// Everything here is UTC, including the {date} route parameter - the AIS feed
/// publishes UTC and the old files were named by UTC date. Do not "fix" this to
/// Kuwait local without also re-basing the stored data.
/// </summary>
[ApiController]
[Route("api/ais-history")]
public class AisHistoryController(DwoDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetIndex(CancellationToken ct)
    {
        // One row per (vessel, UTC day, provider) - the grain the old per-day
        // files had.
        //
        // Grouped on DateTime.Date (which EF turns into CAST(... AS date)) rather
        // than DateOnly.FromDateTime, which has no SQL translation and throws.
        // The formatting happens after the query for the same reason.
        var grouped = await db.AisPositions
            .GroupBy(p => new
            {
                p.Vessel!.VesselCode,
                Day = p.TimestampUtc.Date,
                p.Source,
            })
            .Select(g => new
            {
                g.Key.VesselCode,
                g.Key.Day,
                g.Key.Source,
                Count = g.Count(),
            })
            .ToListAsync(ct);

        var tracks = grouped
            .OrderBy(t => t.VesselCode).ThenBy(t => t.Day)
            .Select(t => new
            {
                vessel_id = t.VesselCode,
                date_utc = t.Day.ToString("yyyy-MM-dd"),
                file = $"ais-history/{t.VesselCode}-{t.Day:yyyy-MM-dd}.json",
                positions = t.Count,
                provider = t.Source,
            })
            .ToList();

        return Ok(new { tracks });
    }

    [HttpGet("{vesselCode}/{date}")]
    public async Task<IActionResult> GetDay(string vesselCode, string date, CancellationToken ct)
    {
        if (!DateOnly.TryParse(date, out var d))
            return BadRequest(new { error = "date must be YYYY-MM-DD" });

        if (!await db.Vessels.AnyAsync(v => v.VesselCode == vesselCode, ct))
            return BadRequest(new { error = "unknown vessel_id" });

        var from = d.ToDateTime(TimeOnly.MinValue);
        var to = from.AddDays(1);

        var positions = await db.AisPositions
            .Where(p => p.Vessel!.VesselCode == vesselCode
                        && p.TimestampUtc >= from && p.TimestampUtc < to)
            .OrderBy(p => p.TimestampUtc)
            .Select(p => new
            {
                ts = p.TimestampUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
                lat = p.Latitude,
                lon = p.Longitude,
                sog = p.SpeedKts,
                cog = p.CourseDeg,
                heading = p.HeadingDeg,
                nav_status = p.NavStatus,
                mmsi = p.Mmsi,
            })
            .ToListAsync(ct);

        if (positions.Count == 0)
            return NotFound(new { error = "no AIS track for that vessel/date" });

        return Ok(new
        {
            vessel_id = vesselCode,
            mmsi = positions[0].mmsi,
            date_utc = date,
            positions,
        });
    }
}
