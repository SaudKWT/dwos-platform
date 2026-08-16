using Koc.Dwos.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Koc.Dwos.Api.Controllers;

/// <summary>
/// Reference data the map needs: the fleet and the places it moves between.
/// These were static files (data/vessels.json, data/locations.json); serving them
/// from the database is what makes the Admin screens possible.
/// </summary>
[ApiController]
[Route("api")]
public class FleetController(DwoDbContext db) : ControllerBase
{
    /// <summary>The fleet, in the shape data/vessels.json used.</summary>
    [HttpGet("vessels")]
    public async Task<IActionResult> GetVessels(CancellationToken ct)
    {
        var vessels = await db.Vessels
            .Where(v => !v.IsDeleted)
            .OrderBy(v => v.Id)
            .Select(v => new
            {
                id = v.VesselCode,
                name = v.VesselName,
                type = v.VesselType,
                length_m = v.LengthM,
                beam_m = v.BeamM,
                speed_kts = v.SpeedKts,
                home_berth = v.HomeBerth!.LocationCode,
                mmsi = v.Mmsi,
                color = v.MapColor,
                stroke = v.MapStroke,
                active_from = v.ActiveFrom,
                retired_on = v.RetiredOn,
                replaced_vessel = v.ReplacedVessel!.VesselCode,
                specs_provisional = v.SpecsProvisional,
            })
            .ToListAsync(ct);

        return Ok(new { vessels });
    }

    /// <summary>Locations and their aliases, in the shape data/locations.json used.</summary>
    [HttpGet("locations")]
    public async Task<IActionResult> GetLocations(CancellationToken ct)
    {
        var locations = await db.MarineLocations
            .Where(l => !l.IsDeleted)
            .OrderBy(l => l.Id)
            .Select(l => new
            {
                id = l.LocationCode,
                name = l.LocationName,
                @short = l.ShortName,
                lat = l.Latitude,
                lon = l.Longitude,
                type = l.LocationType,
                berth_use = l.BerthUse,
            })
            .ToListAsync(ct);

        var aliasRows = await db.MarineLocationAliases
            .Select(a => new { a.Alias, Code = a.MarineLocation!.LocationCode, a.ResolutionHint })
            .ToListAsync(ct);

        // An ambiguous alias ("Shuaiba Port" means a different berth per vessel)
        // has no location. It is still returned - with its hint instead of a
        // code - so a caller can see it exists and resolve it, rather than
        // silently finding nothing and treating the text as unknown.
        var aliases = aliasRows.ToDictionary(
            a => a.Alias,
            a => (object)(a.Code ?? $"__{a.ResolutionHint}__"));

        return Ok(new { locations, aliases });
    }
}
