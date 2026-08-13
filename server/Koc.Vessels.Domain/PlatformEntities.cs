namespace Koc.Vessels.Domain;

// Entities for the corporate tables in database/001-schema0726.sql that the
// PLATFORM needs, as opposed to any one module.
//
// READ-ONLY, AND WHY THAT IS ENFORCED HERE RATHER THAN REMEMBERED
// ---------------------------------------------------------------
// 001 is the corporate schema, kept byte-for-byte as the DBA delivered it, and
// it may be shared with other KOC systems. Nothing in this platform writes to
// it. Every type below is configured `.ToTable(..., t => t.ExcludeFromMigrations())`
// and queried with AsNoTracking in the controllers, so an accidental SaveChanges
// cannot carry a change into a table we do not own.
//
// Only what is actually needed is modelled. Scaffolding all 43 would create
// forty-three opportunities to write to one of them.
//
//   Module / Form        the in-database application registry. 004 registers a
//                        module here; dbo.Log.ModuleID is NOT NULL, so a module
//                        with no row cannot write an audit entry at all.
//   Entity / EntityType  the org hierarchy — Directorate > Group > Team > Unit,
//                        four levels in one self-referencing table. A unit in
//                        the dashboard's TeamConfig is an Entity row.
//   Rig / Contractor     shared reference data the marine module already has
//                        real foreign keys into (MarineLocation.RigID,
//                        Vessel.ContractorID).
//
// Column names are the corporate schema's, not ours — [ID], [IsActive],
// [isActive] on Contractor. The casing inconsistency is theirs and is preserved
// rather than tidied, because matching the delivered file is what makes a later
// diff against the DBA's copy meaningful.

/// <summary>A registered application. `dbo.Module`.</summary>
public class AppModule
{
    public int Id { get; set; }
    public string ModuleName { get; set; } = "";
    public string? Description { get; set; }
    public int? ParentModuleId { get; set; }
    public int? DisplayOrder { get; set; }
    public int? PrivilegeId { get; set; }
    public bool IsAttachedToMenu { get; set; }
    public bool IsActive { get; set; }

    public List<AppForm> Forms { get; set; } = [];
}

/// <summary>A screen within a module. `dbo.Form`.</summary>
public class AppForm
{
    public int Id { get; set; }
    public string FormName { get; set; } = "";
    public string? Description { get; set; }
    public int? ModuleId { get; set; }
    public int? ParentFormId { get; set; }
    public int? DisplayOrder { get; set; }
    public int? PrivilegeId { get; set; }
    public bool IsActive { get; set; }
}

/// <summary>
/// A node in the org hierarchy. `dbo.Entity`.
///
/// This is the table the dashboard's seven units bind to. `RigInfo.TeamID` and
/// `Workover.TeamID` hold an Entity Id, which is how operational work is scoped
/// to a unit — and why a wrong binding does not error, it silently returns
/// another unit's rigs.
/// </summary>
public class OrgEntity
{
    public int Id { get; set; }
    public string EntityCode { get; set; } = "";
    public string EntityName { get; set; } = "";
    public int EntityTypeId { get; set; }
    public int? ParentEntityId { get; set; }
    public string? Description { get; set; }
    public bool IsActive { get; set; }
    public int IsVirtual { get; set; }

    public OrgEntityType? EntityType { get; set; }
}

/// <summary>Directorate / Group / Team / Unit. `dbo.EntityType`.</summary>
public class OrgEntityType
{
    public int Id { get; set; }
    public string TypeName { get; set; } = "";
    public bool IsActive { get; set; }
}

/// <summary>Shared reference. `dbo.Rig` — marine locations point at these.</summary>
public class Rig
{
    public int Id { get; set; }
    public string RigName { get; set; } = "";
    public int? RigTypeId { get; set; }
    public bool IsActive { get; set; }
    public bool IsDeleted { get; set; }
}

/// <summary>Shared reference. `dbo.Contractor` — vessel owners.</summary>
public class Contractor
{
    public int Id { get; set; }
    public string ContractorName { get; set; } = "";
    public string? ContractorCode { get; set; }
    // Lower-case `i` is the corporate schema's, preserved deliberately.
    public bool? IsActive { get; set; }
    public bool? IsDeleted { get; set; }
}
