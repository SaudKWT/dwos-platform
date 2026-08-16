using Koc.Dwos.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Koc.Dwos.Api.Modules.Platform;

/// <summary>
/// Platform endpoints — the things that belong to the DWOS platform itself
/// rather than to any one module.
///
/// WHY THIS EXISTS
/// ---------------
/// The API modelled marine tables and nothing else, so two things the platform
/// needs had no way to reach the client:
///
///   The module registry. 004-register-modules.sql writes rows into dbo.Module,
///   dbo.Form, dbo.Privilege and dbo.Status. Nothing read them back, which made
///   the registry write-only — a menu stored in the database that no menu could
///   be built from.
///
///   The org hierarchy. The dashboard's seven units each need an EntityCode and
///   the Entity Id that RigInfo.TeamID / Workover.TeamID hold. Without it every
///   unit screen is unscoped, and an unscoped query on a unit screen shows the
///   whole directorate's work while looking entirely normal doing it. The
///   client's schema-binding.ts carries seven nulls waiting for exactly this.
///
/// Everything here is READ-ONLY against corporate tables. AsNoTracking is not an
/// optimisation, it is the guarantee: nothing this controller loads can be
/// written back by a stray SaveChanges elsewhere in the request.
/// </summary>
[ApiController]
[Route("api")]
public class OrgController(DwoDbContext db) : ControllerBase
{
    /// <summary>
    /// Registered modules and their screens, in menu order.
    ///
    /// A module with no forms is a menu entry that goes nowhere, and one with no
    /// PrivilegeId is ungated — both are what migrate.sh's verification refuses
    /// to let through, so both are surfaced here rather than silently served.
    /// </summary>
    [HttpGet("modules")]
    public async Task<IActionResult> GetModules(CancellationToken ct)
    {
        var modules = await db.Modules
            .AsNoTracking()
            .Where(m => m.IsActive)
            .OrderBy(m => m.DisplayOrder).ThenBy(m => m.Id)
            .Select(m => new
            {
                id = m.Id,
                name = m.ModuleName,
                description = m.Description,
                parent_module_id = m.ParentModuleId,
                display_order = m.DisplayOrder,
                privilege_id = m.PrivilegeId,
                attached_to_menu = m.IsAttachedToMenu,
                forms = db.Forms
                    .Where(f => f.ModuleId == m.Id && f.IsActive)
                    .OrderBy(f => f.DisplayOrder).ThenBy(f => f.Id)
                    .Select(f => new
                    {
                        id = f.Id,
                        name = f.FormName,
                        description = f.Description,
                        display_order = f.DisplayOrder,
                        privilege_id = f.PrivilegeId,
                    })
                    .ToList(),
            })
            .ToListAsync(ct);

        return Ok(new { modules });
    }

    /// <summary>
    /// The org hierarchy, optionally filtered to one level.
    ///
    /// `?type=Unit` is the call the dashboard needs: it returns the rows whose
    /// Id goes into RigInfo.TeamID. Ids are per-database — 001 declares no unique
    /// constraint anywhere and every table keys on int IDENTITY — so a client
    /// must resolve by EntityCode at runtime and never hardcode the integer.
    /// </summary>
    [HttpGet("org/entities")]
    public async Task<IActionResult> GetEntities([FromQuery] string? type, CancellationToken ct)
    {
        var q = db.OrgEntities.AsNoTracking().Where(e => e.IsActive);
        if (!string.IsNullOrWhiteSpace(type))
            q = q.Where(e => e.EntityType!.TypeName == type);

        var entities = await q
            .OrderBy(e => e.EntityCode)
            .Select(e => new
            {
                id = e.Id,
                code = e.EntityCode,
                name = e.EntityName,
                type = e.EntityType!.TypeName,
                parent_entity_id = e.ParentEntityId,
            })
            .ToListAsync(ct);

        return Ok(new { entities });
    }

    /// <summary>
    /// What this deployment is, in one call, for a client deciding what it can
    /// scope and what it must grey out.
    ///
    /// `org_seeded` is the honest bit. A fresh DWO built from 000..004 has an
    /// EMPTY dbo.Entity — 001 ships DDL and no rows — so the seven unit bindings
    /// cannot be resolved locally at all. Returning the count lets the dashboard
    /// say "not scoped to this unit yet" instead of quietly showing everything.
    /// </summary>
    [HttpGet("platform")]
    public async Task<IActionResult> GetPlatform(CancellationToken ct) => Ok(new
    {
        modules = await db.Modules.CountAsync(m => m.IsActive, ct),
        org_seeded = await db.OrgEntities.CountAsync(ct),
        units = await db.OrgEntities.CountAsync(e => e.EntityType!.TypeName == "Unit", ct),
        rigs = await db.Rigs.CountAsync(r => !r.IsDeleted, ct),
        contractors = await db.Contractors.CountAsync(c => c.IsDeleted != true, ct),
    });
}
