using Koc.Vessels.Domain;
using Microsoft.EntityFrameworkCore;

namespace Koc.Vessels.Infrastructure;

/// <summary>
/// EF Core context over the DWO database.
///
/// The schema is owned by database/*.sql, not by EF. There are no EF migrations
/// here on purpose: DWO is a corporate database that may be shared with other
/// systems, and EF Core's migration model assumes it owns everything it can see.
/// One "dotnet ef migrations add" against a scaffolded legacy schema is enough to
/// generate a script that drops tables belonging to somebody else. Schema changes
/// ship as numbered SQL scripts applied by database/migrate.sh.
///
/// Only marine tables are mapped. The legacy drilling tables are read through
/// explicit queries where needed, so a mistake here cannot write to them.
/// </summary>
public class DwoDbContext(DbContextOptions<DwoDbContext> options) : DbContext(options)
{
    public DbSet<Vessel> Vessels => Set<Vessel>();
    public DbSet<MarineLocation> MarineLocations => Set<MarineLocation>();
    public DbSet<MarineLocationAlias> MarineLocationAliases => Set<MarineLocationAlias>();
    public DbSet<VesselDailyReport> VesselDailyReports => Set<VesselDailyReport>();
    public DbSet<VesselReportTask> VesselReportTasks => Set<VesselReportTask>();
    public DbSet<VesselReportConsumable> VesselReportConsumables => Set<VesselReportConsumable>();
    public DbSet<VesselReportCrew> VesselReportCrew => Set<VesselReportCrew>();
    public DbSet<MovementPlan> MovementPlans => Set<MovementPlan>();
    public DbSet<MovementPlanVessel> MovementPlanVessels => Set<MovementPlanVessel>();
    public DbSet<MovementPlanSnapshot> MovementPlanSnapshots => Set<MovementPlanSnapshot>();
    public DbSet<MovementPlanLeg> MovementPlanLegs => Set<MovementPlanLeg>();
    public DbSet<AisPosition> AisPositions => Set<AisPosition>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        // Decimal precision must be declared explicitly.
        //
        // EF Core does NOT read precision back from the database. Left alone it
        // sends every decimal as decimal(18,2), which silently ROUNDS the value
        // in the parameter before SQL Server ever sees it - the column's own
        // decimal(10,7) never gets a chance to hold what was sent. Latitude
        // 28.912411 was stored as 28.91, putting every vessel and berth up to a
        // kilometre from where it belongs, with no error raised anywhere.
        //
        // Any new decimal property needs a matching HasPrecision here.
        b.Entity<MarineLocation>(e =>
        {
            e.Property(x => x.Latitude).HasPrecision(10, 7);
            e.Property(x => x.Longitude).HasPrecision(10, 7);
        });
        b.Entity<Vessel>(e =>
        {
            e.Property(x => x.LengthM).HasPrecision(8, 2);
            e.Property(x => x.BeamM).HasPrecision(8, 2);
            e.Property(x => x.SpeedKts).HasPrecision(5, 2);
        });
        b.Entity<AisPosition>(e =>
        {
            e.Property(x => x.Latitude).HasPrecision(10, 7);
            e.Property(x => x.Longitude).HasPrecision(10, 7);
            e.Property(x => x.SpeedKts).HasPrecision(6, 2);
            e.Property(x => x.CourseDeg).HasPrecision(6, 2);
            e.Property(x => x.HeadingDeg).HasPrecision(6, 2);
        });

        b.Entity<MarineLocation>(e =>
        {
            e.ToTable("MarineLocation");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.RigId).HasColumnName("RigID");
            e.HasIndex(x => x.LocationCode).IsUnique();
            e.HasMany(x => x.Aliases).WithOne(x => x.MarineLocation)
             .HasForeignKey(x => x.MarineLocationId);
        });

        b.Entity<MarineLocationAlias>(e =>
        {
            e.ToTable("MarineLocationAlias");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.MarineLocationId).HasColumnName("MarineLocationID");
            e.HasIndex(x => x.Alias).IsUnique();
        });

        b.Entity<Vessel>(e =>
        {
            e.ToTable("Vessel");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.Mmsi).HasColumnName("MMSI");
            e.Property(x => x.HomeBerthLocationId).HasColumnName("HomeBerthLocationID");
            e.Property(x => x.ContractorId).HasColumnName("ContractorID");
            e.Property(x => x.ReplacedVesselId).HasColumnName("ReplacedVesselID");
            e.HasIndex(x => x.VesselCode).IsUnique();
            e.HasOne(x => x.HomeBerth).WithMany().HasForeignKey(x => x.HomeBerthLocationId);
            e.HasOne(x => x.ReplacedVessel).WithMany().HasForeignKey(x => x.ReplacedVesselId);
        });

        b.Entity<VesselDailyReport>(e =>
        {
            e.ToTable("VesselDailyReport");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.VesselId).HasColumnName("VesselID");
            e.Property(x => x.CreatedByUserId).HasColumnName("CreatedByUserID");
            e.Property(x => x.ModifiedByUserId).HasColumnName("ModifiedByUserID");
            // One report per vessel per day; a re-submission overwrites.
            e.HasIndex(x => new { x.VesselId, x.ReportDate }).IsUnique();
            e.HasOne(x => x.Vessel).WithMany().HasForeignKey(x => x.VesselId);
            e.HasMany(x => x.Tasks).WithOne().HasForeignKey(x => x.VesselDailyReportId)
             .OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Consumables).WithOne().HasForeignKey(x => x.VesselDailyReportId)
             .OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Crew).WithOne().HasForeignKey(x => x.VesselDailyReportId)
             .OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<VesselReportTask>(e =>
        {
            e.ToTable("VesselReportTask");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.VesselDailyReportId).HasColumnName("VesselDailyReportID");
            e.Property(x => x.LocationId).HasColumnName("LocationID");
            e.Property(x => x.FromLocationId).HasColumnName("FromLocationID");
            e.Property(x => x.ToLocationId).HasColumnName("ToLocationID");
            e.HasOne(x => x.Location).WithMany().HasForeignKey(x => x.LocationId);
            e.HasOne(x => x.FromLocation).WithMany().HasForeignKey(x => x.FromLocationId);
            e.HasOne(x => x.ToLocation).WithMany().HasForeignKey(x => x.ToLocationId);
        });

        b.Entity<VesselReportConsumable>(e =>
        {
            e.ToTable("VesselReportConsumable");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.VesselDailyReportId).HasColumnName("VesselDailyReportID");
        });

        b.Entity<VesselReportCrew>(e =>
        {
            e.ToTable("VesselReportCrew");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.VesselDailyReportId).HasColumnName("VesselDailyReportID");
        });

        b.Entity<MovementPlan>(e =>
        {
            e.ToTable("MovementPlan");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.CreatedByUserId).HasColumnName("CreatedByUserID");
            e.Property(x => x.ModifiedByUserId).HasColumnName("ModifiedByUserID");
            e.HasIndex(x => x.PlanDate).IsUnique();
            e.HasMany(x => x.Vessels).WithOne().HasForeignKey(x => x.MovementPlanId)
             .OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Snapshots).WithOne().HasForeignKey(x => x.MovementPlanId)
             .OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Legs).WithOne().HasForeignKey(x => x.MovementPlanId)
             .OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<MovementPlanVessel>(e =>
        {
            e.ToTable("MovementPlanVessel");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.MovementPlanId).HasColumnName("MovementPlanID");
            e.Property(x => x.VesselId).HasColumnName("VesselID");
            e.HasIndex(x => new { x.MovementPlanId, x.VesselId }).IsUnique();
            e.HasOne(x => x.Vessel).WithMany().HasForeignKey(x => x.VesselId);
        });

        b.Entity<MovementPlanSnapshot>(e =>
        {
            e.ToTable("MovementPlanSnapshot");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.MovementPlanId).HasColumnName("MovementPlanID");
            e.Property(x => x.VesselId).HasColumnName("VesselID");
            e.Property(x => x.MarineLocationId).HasColumnName("MarineLocationID");
            e.HasIndex(x => new { x.MovementPlanId, x.VesselId }).IsUnique();
            e.HasOne(x => x.Vessel).WithMany().HasForeignKey(x => x.VesselId);
            e.HasOne(x => x.MarineLocation).WithMany().HasForeignKey(x => x.MarineLocationId);
        });

        b.Entity<MovementPlanLeg>(e =>
        {
            e.ToTable("MovementPlanLeg");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.MovementPlanId).HasColumnName("MovementPlanID");
            e.Property(x => x.VesselId).HasColumnName("VesselID");
            e.Property(x => x.ParentLegId).HasColumnName("ParentLegID");
            e.Property(x => x.FromLocationId).HasColumnName("FromLocationID");
            e.Property(x => x.ToLocationId).HasColumnName("ToLocationID");
            e.HasOne(x => x.Vessel).WithMany().HasForeignKey(x => x.VesselId);
            e.HasOne(x => x.FromLocation).WithMany().HasForeignKey(x => x.FromLocationId);
            e.HasOne(x => x.ToLocation).WithMany().HasForeignKey(x => x.ToLocationId);
            e.HasOne(x => x.ParentLeg).WithMany().HasForeignKey(x => x.ParentLegId);
        });

        b.Entity<AisPosition>(e =>
        {
            e.ToTable("AisPosition");
            e.Property(x => x.Id).HasColumnName("ID");
            e.Property(x => x.VesselId).HasColumnName("VesselID");
            e.Property(x => x.Mmsi).HasColumnName("MMSI");
            e.HasIndex(x => new { x.VesselId, x.TimestampUtc });
            e.HasIndex(x => new { x.VesselId, x.TimestampUtc, x.Source }).IsUnique();
            e.HasOne(x => x.Vessel).WithMany().HasForeignKey(x => x.VesselId);
        });
    }
}
