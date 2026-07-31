namespace Koc.Vessels.Domain;

// Entities for the marine tables created by database/002-marine-tables.sql.
//
// Only the vessel-movement tables are modelled. The legacy drilling tables from
// 001-schema0726.sql are deliberately absent: we read a handful of them (Rig,
// Contractor, User) and never write them, so they are mapped as-needed rather
// than scaffolded wholesale.
//
// Times are Kuwait local (UTC+3) everywhere except AisPosition, whose feed is
// UTC. See the header of 002-marine-tables.sql.

public class MarineLocation
{
    public int Id { get; set; }
    public string LocationCode { get; set; } = "";
    public string LocationName { get; set; } = "";
    public string? ShortName { get; set; }
    public decimal Latitude { get; set; }
    public decimal Longitude { get; set; }
    public string LocationType { get; set; } = "";
    public string? BerthUse { get; set; }
    public int? RigId { get; set; }
    public bool IsActive { get; set; } = true;
    public bool IsDeleted { get; set; }

    public List<MarineLocationAlias> Aliases { get; set; } = [];
}

public class MarineLocationAlias
{
    public int Id { get; set; }

    /// <summary>
    /// Null when the alias is ambiguous — a bare "Shuaiba Port" means berth 4 to
    /// the crew boats and berth 20 to the PSVs. Use <see cref="ResolutionHint"/>.
    /// </summary>
    public int? MarineLocationId { get; set; }

    public string Alias { get; set; } = "";

    /// <summary>'vessel_home_berth' when the alias can only be resolved per vessel.</summary>
    public string? ResolutionHint { get; set; }

    public MarineLocation? MarineLocation { get; set; }
}

public class Vessel
{
    public int Id { get; set; }
    public string VesselCode { get; set; } = "";
    public string VesselName { get; set; } = "";
    public string? VesselType { get; set; }
    public decimal? LengthM { get; set; }
    public decimal? BeamM { get; set; }
    public decimal? SpeedKts { get; set; }
    public int? HomeBerthLocationId { get; set; }
    public string? Mmsi { get; set; }

    /// <summary>
    /// IMO number. Outlives <see cref="Mmsi"/>, which is reassigned when a ship
    /// changes flag — so this is what identifies the hull across a re-flag.
    /// </summary>
    public string? Imo { get; set; }

    public string? CallSign { get; set; }
    public string? Flag { get; set; }
    public string? MapColor { get; set; }
    public string? MapStroke { get; set; }
    public int? ContractorId { get; set; }

    /// <summary>First day the vessel appears on the map. Null = since forever.</summary>
    public DateOnly? ActiveFrom { get; set; }

    /// <summary>
    /// Day the vessel left service. Null = still in service. Load-bearing: without
    /// it the simulator carries a retired vessel's last position forward for ever
    /// and draws it alongside its replacement at the same berth.
    /// </summary>
    public DateOnly? RetiredOn { get; set; }

    public int? ReplacedVesselId { get; set; }

    /// <summary>True when the dimensions are a stand-in until real particulars arrive.</summary>
    public bool SpecsProvisional { get; set; }

    public string? Notes { get; set; }
    public bool IsActive { get; set; } = true;
    public bool IsDeleted { get; set; }

    public MarineLocation? HomeBerth { get; set; }
    public Vessel? ReplacedVessel { get; set; }
}

public class VesselDailyReport
{
    public int Id { get; set; }
    public int VesselId { get; set; }
    public DateOnly ReportDate { get; set; }
    public string? PeriodEnd { get; set; }
    public string? VoyageNo { get; set; }
    public string? CompiledByName { get; set; }
    public string? CompiledByRole { get; set; }
    public DateTime? SubmittedAt { get; set; }
    public string? SafetyAccidents { get; set; }
    public string? SafetyIncidents { get; set; }
    public string? SafetyNearMiss { get; set; }
    public int? DaysSincePortCall { get; set; }
    public int? SecurityLevel { get; set; }
    public string? NextCrewChange { get; set; }
    public string? IssuesComments { get; set; }
    public string? AccidentSummary { get; set; }

    public string? SourceType { get; set; }
    public string? SourceEmailSubject { get; set; }
    public string? SourceEmailFrom { get; set; }
    public DateTime? SourceEmailDate { get; set; }
    public string? SourceAttachment { get; set; }
    public string? SourceSubmittedVia { get; set; }

    /// <summary>
    /// The complete original payload. The PDFs differ per vessel, so this is what
    /// guarantees the import is lossless and lets fields be promoted to columns
    /// later without re-reading PDFs.
    /// </summary>
    public string? RawJson { get; set; }

    public DateTime CreatedOn { get; set; }
    public int? CreatedByUserId { get; set; }
    public DateTime? ModifiedOn { get; set; }
    public int? ModifiedByUserId { get; set; }
    public bool IsDeleted { get; set; }

    public Vessel? Vessel { get; set; }
    public List<VesselReportTask> Tasks { get; set; } = [];
    public List<VesselReportConsumable> Consumables { get; set; } = [];
    public List<VesselReportCrew> Crew { get; set; } = [];
}

public class VesselReportTask
{
    public int Id { get; set; }
    public int VesselDailyReportId { get; set; }
    public int SortOrder { get; set; }

    /// <summary>Text, not TimeOnly: '24:00' is a valid end-of-day in these reports.</summary>
    public string? FromTime { get; set; }
    public string? ToTime { get; set; }

    public int? DurationMin { get; set; }
    public string? TaskCode { get; set; }
    public string? TaskLabel { get; set; }
    public string? Description { get; set; }
    public int? LocationId { get; set; }
    public int? FromLocationId { get; set; }
    public int? ToLocationId { get; set; }

    public MarineLocation? Location { get; set; }
    public MarineLocation? FromLocation { get; set; }
    public MarineLocation? ToLocation { get; set; }
}

public class VesselReportConsumable
{
    public int Id { get; set; }
    public int VesselDailyReportId { get; set; }
    public string ConsumableKey { get; set; } = "";
    public string? Label { get; set; }
    public int SortOrder { get; set; }

    // Text, units and all ('417.42 M3', '950 M3 (80%)', '-') exactly as the PDFs
    // print them. Parsing to decimal is a later decision; storing raw first means
    // the import cannot silently corrupt a figure.
    public string? MaxCapacity { get; set; }
    public string? Consumed { get; set; }
    public string? Loaded { get; set; }
    public string? Discharged { get; set; }
    public string? Rob { get; set; }
    public string? RemainingToLoad { get; set; }
    public string? Remarks { get; set; }
}

public class VesselReportCrew
{
    public int Id { get; set; }
    public int VesselDailyReportId { get; set; }
    public string PersonType { get; set; } = "crew";   // crew | passenger
    public int SortOrder { get; set; }
    public string? FirstName { get; set; }
    public string? LastName { get; set; }
    public string? Position { get; set; }
    public string? DaysOnboard { get; set; }
    public string? SignOnDate { get; set; }
    public string? PlannedCrewChange { get; set; }
}

public class MovementPlan
{
    public int Id { get; set; }
    public DateOnly PlanDate { get; set; }
    public DateOnly? IssuedDate { get; set; }
    public DateTime? SnapshotAt { get; set; }
    public string? IssuedBy { get; set; }
    public string? IssuedRole { get; set; }
    public string? Subject { get; set; }
    public string? Narrative { get; set; }

    public string? SourceType { get; set; }
    public string? SourceEmailSubject { get; set; }
    public string? SourceEmailFrom { get; set; }
    public DateTime? SourceEmailDate { get; set; }
    public string? SourceAttachment { get; set; }
    public string? SourceSubmittedVia { get; set; }
    public string? RawJson { get; set; }

    public DateTime CreatedOn { get; set; }
    public int? CreatedByUserId { get; set; }
    public DateTime? ModifiedOn { get; set; }
    public int? ModifiedByUserId { get; set; }
    public bool IsDeleted { get; set; }

    /// <summary>The narrative bullets as received from the supervisor.</summary>
    public List<MovementPlanVessel> Vessels { get; set; } = [];

    /// <summary>Where each vessel was when the plan was written.</summary>
    public List<MovementPlanSnapshot> Snapshots { get; set; } = [];

    /// <summary>The curated structure the map animates.</summary>
    public List<MovementPlanLeg> Legs { get; set; } = [];
}

public class MovementPlanVessel
{
    public int Id { get; set; }
    public int MovementPlanId { get; set; }
    public int VesselId { get; set; }
    public int SortOrder { get; set; }
    public string? CurrentStatus { get; set; }
    public string? TomorrowPlan { get; set; }
    public string? Additional { get; set; }
    public string? Notes { get; set; }

    public Vessel? Vessel { get; set; }
}

public class MovementPlanSnapshot
{
    public int Id { get; set; }
    public int MovementPlanId { get; set; }
    public int VesselId { get; set; }
    public int? MarineLocationId { get; set; }
    public string? RawText { get; set; }

    public Vessel? Vessel { get; set; }
    public MarineLocation? MarineLocation { get; set; }
}

public class MovementPlanLeg
{
    public int Id { get; set; }
    public int MovementPlanId { get; set; }
    public int VesselId { get; set; }
    public int? ParentLegId { get; set; }
    public string LegType { get; set; } = "movement";   // movement | return
    public int SortOrder { get; set; }
    public DateTime? Etd { get; set; }
    public DateTime? Eta { get; set; }
    public int? FromLocationId { get; set; }
    public int? ToLocationId { get; set; }

    /// <summary>JSON array of location codes, e.g. ["NP","OPH"].</summary>
    public string? ViaJson { get; set; }

    public string? Purpose { get; set; }
    public string? RawText { get; set; }

    /// <summary>Source ETD was ambiguous or TBC — the map should not present it as fact.</summary>
    public bool EtdUncertain { get; set; }
    public string? EtdSource { get; set; }

    public Vessel? Vessel { get; set; }
    public MarineLocation? FromLocation { get; set; }
    public MarineLocation? ToLocation { get; set; }
    public MovementPlanLeg? ParentLeg { get; set; }
}

public class AisPosition
{
    public long Id { get; set; }
    public int VesselId { get; set; }

    /// <summary>UTC — unlike every other timestamp in this model. The AIS feed publishes UTC.</summary>
    public DateTime TimestampUtc { get; set; }

    public decimal Latitude { get; set; }
    public decimal Longitude { get; set; }
    public decimal? SpeedKts { get; set; }
    public decimal? CourseDeg { get; set; }
    public decimal? HeadingDeg { get; set; }
    public string? NavStatus { get; set; }
    public string? Mmsi { get; set; }
    public string Source { get; set; } = "import";   // datalastic | aisstream | import

    public Vessel? Vessel { get; set; }
}
