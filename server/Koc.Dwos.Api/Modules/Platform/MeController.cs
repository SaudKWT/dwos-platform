using Koc.Dwos.Infrastructure;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Koc.Dwos.Api.Modules.Platform;

/// <summary>
/// Who is calling, and what may they do.
///
/// Windows/AD hands us an identity like <c>KOC\jsmith</c>; this endpoint turns
/// it into the corporate user row and a set of privilege names. The client
/// reads it once at startup: the identity for display, the privileges for
/// deciding which modules and forms to offer — the same PrivilegeIDs that
/// dbo.Module and dbo.Form point at, registered by 004.
///
/// AllowAnonymous deliberately, even in Windows mode: an unauthenticated caller
/// gets <c>authenticated: false</c> as JSON rather than a bare 401, so the SPA
/// can render "not signed in" instead of a broken fetch. Every other endpoint
/// still requires auth via the fallback policy.
///
/// Privileges resolve as the union of direct grants (dbo.UserPrivilege) and
/// role-carried grants (dbo.UserRole → dbo.RolePrivilege), each date-windowed:
/// a null StartDate/EndDate means unbounded on that side, matching how the
/// corporate schema leaves them null in practice.
/// </summary>
[ApiController]
[Route("api")]
public class MeController(DwoDbContext db) : ControllerBase
{
    [HttpGet("me")]
    [AllowAnonymous]
    public async Task<IActionResult> GetMe([FromServices] IConfiguration cfg, CancellationToken ct)
    {
        var mode = cfg["Auth:Mode"] ?? "Disabled";
        var identity = User.Identity?.IsAuthenticated == true ? User.Identity!.Name : null;

        if (identity is null)
        {
            return Ok(new { auth_mode = mode, authenticated = false, identity = (string?)null, user = (object?)null, privileges = Array.Empty<string>() });
        }

        // "KOC\jsmith" -> "jsmith"; dbo.[User].Username format is not certain
        // to carry the domain, so match either spelling, case-insensitively.
        var sam = identity.Contains('\\') ? identity[(identity.LastIndexOf('\\') + 1)..] : identity;

        var user = await db.Users
            .AsNoTracking()
            .Include(u => u.Profile)
            .Where(u => u.IsActive && !u.IsDeleted)
            .FirstOrDefaultAsync(u => u.Username == sam || u.Username == identity, ct);

        if (user is null)
        {
            // Authenticated by Windows but unknown to DWO: a real state, not an
            // error. The identity is shown; the app offers nothing gated.
            return Ok(new { auth_mode = mode, authenticated = true, identity, user = (object?)null, privileges = Array.Empty<string>() });
        }

        var now = DateTime.Now; // Kuwait local, like the rest of the schema

        var direct = db.UserPrivileges
            .Where(up => up.UserId == user.Id
                && (up.StartDate == null || up.StartDate <= now)
                && (up.EndDate == null || up.EndDate >= now))
            .Select(up => up.PrivilegeId);

        var viaRoles = db.UserRoles
            .Where(ur => ur.UserId == user.Id
                && (ur.StartDate == null || ur.StartDate <= now)
                && (ur.EndDate == null || ur.EndDate >= now))
            .Join(db.Roles.Where(r => r.IsActive), ur => ur.RoleId, r => r.Id, (ur, r) => r.Id)
            .Join(db.RolePrivileges, rid => rid, rp => rp.RoleId, (_, rp) => rp.PrivilegeId);

        var privileges = await db.Privileges
            .AsNoTracking()
            .Where(p => p.IsActive && (direct.Contains(p.Id) || viaRoles.Contains(p.Id)))
            .Select(p => p.PrivilegeName)
            .Distinct()
            .OrderBy(n => n)
            .ToListAsync(ct);

        return Ok(new
        {
            auth_mode = mode,
            authenticated = true,
            identity,
            user = new
            {
                id = user.Id,
                username = user.Username,
                koc_number = user.Profile?.KocNumber,
                first = user.Profile?.FirstName,
                last = user.Profile?.LastName,
                designation = user.Profile?.Designation,
                email = user.Profile?.Email,
            },
            privileges,
        });
    }
}
