using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Koc.Vessels.Domain;
using Koc.Vessels.Infrastructure;
using Microsoft.EntityFrameworkCore;

// =============================================================================
// Loads the app's JSON files into the DWO database.
//
//   set -a; source keys.env; set +a
//   dotnet run --project server/Koc.Vessels.Importer -- [--data <dir>] [--verify-only]
//
// Re-runnable: it clears the marine tables and reloads from the files, so it can
// be run repeatedly during the migration and once more at cutover. It never
// touches a table from 001-schema0726.sql.
//
// Every report and plan keeps its complete original JSON in a RawJson column, so
// a field this importer does not understand is preserved rather than dropped.
// =============================================================================

var dataDir = "data";
var verifyOnly = false;
for (var i = 0; i < args.Length; i++)
{
    if (args[i] == "--data" && i + 1 < args.Length) dataDir = args[++i];
    else if (args[i] == "--verify-only") verifyOnly = true;
}

// Walk up from the working directory to the repo root, so the tool runs from anywhere.
var root = Directory.GetCurrentDirectory();
while (!Directory.Exists(Path.Combine(root, dataDir)) && Directory.GetParent(root) is { } parent)
    root = parent.FullName;

var dataPath = Path.Combine(root, dataDir);
if (!Directory.Exists(dataPath))
{
    Console.Error.WriteLine($"error: data directory not found: {dataPath}");
    return 1;
}

var conn = Environment.GetEnvironmentVariable("ConnectionStrings__Dwo");
if (string.IsNullOrWhiteSpace(conn))
{
    Console.Error.WriteLine("error: ConnectionStrings__Dwo is not set. Run with:");
    Console.Error.WriteLine("  set -a; source keys.env; set +a; dotnet run --project server/Koc.Vessels.Importer");
    return 1;
}

var options = new DbContextOptionsBuilder<DwoDbContext>().UseSqlServer(conn).Options;
await using var db = new DwoDbContext(options);

var report = new ImportReport();

Console.WriteLine($"Data : {dataPath}");
Console.WriteLine();

if (!verifyOnly)
{
    await ClearAsync(db);
    await ImportLocationsAsync(db, dataPath, report);
    await ImportVesselsAsync(db, dataPath, report);
    await ImportDailyReportsAsync(db, dataPath, report);
    await ImportStructuredPlansAsync(db, dataPath, report);
    await ImportNarrativePlansAsync(db, dataPath, report);
    await ImportAisAsync(db, dataPath, report);
}

var ok = await VerifyAsync(db, dataPath, report);
return ok ? 0 : 1;

// -----------------------------------------------------------------------------

static async Task ClearAsync(DwoDbContext db)
{
    Console.WriteLine("==> Clearing marine tables");
    // Child-first. Cascades would cover most of this, but being explicit means
    // the order is obvious to the next reader and does not depend on FK config.
    foreach (var t in new[]
    {
        "AisPosition", "MovementPlanLeg", "MovementPlanSnapshot", "MovementPlanVessel",
        "MovementPlan", "VesselReportCrew", "VesselReportConsumable", "VesselReportTask",
        "VesselDailyReport"
    })
        await db.Database.ExecuteSqlRawAsync($"DELETE FROM dbo.[{t}];");

    // Vessel.HomeBerthLocationID points at MarineLocation, so vessels go first.
    await db.Database.ExecuteSqlRawAsync("DELETE FROM dbo.[Vessel];");
    await db.Database.ExecuteSqlRawAsync("DELETE FROM dbo.[MarineLocationAlias];");
    await db.Database.ExecuteSqlRawAsync("DELETE FROM dbo.[MarineLocation];");
}

static async Task ImportLocationsAsync(DwoDbContext db, string dataPath, ImportReport report)
{
    Console.WriteLine("==> Locations");
    var json = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(dataPath, "locations.json")))!;

    foreach (var node in json["locations"]!.AsArray())
    {
        db.MarineLocations.Add(new MarineLocation
        {
            LocationCode = node!["id"]!.GetValue<string>(),
            LocationName = node["name"]!.GetValue<string>(),
            ShortName    = node["short"]?.GetValue<string>(),
            Latitude     = node["lat"]!.GetValue<decimal>(),
            Longitude    = node["lon"]!.GetValue<decimal>(),
            LocationType = node["type"]!.GetValue<string>(),
            BerthUse     = node["berth_use"]?.GetValue<string>(),
        });
        report.Locations++;
    }
    await db.SaveChangesAsync();

    var byCode = await db.MarineLocations.ToDictionaryAsync(x => x.LocationCode, x => x.Id);

    foreach (var kv in json["aliases"]!.AsObject())
    {
        var alias = kv.Key;
        var target = kv.Value!.GetValue<string>();

        if (byCode.TryGetValue(target, out var locId))
        {
            db.MarineLocationAliases.Add(new MarineLocationAlias { Alias = alias, MarineLocationId = locId });
        }
        else
        {
            // "B20_or_B4" is not a location: it is the source's way of saying
            // "depends on the vessel". Record it as unresolved rather than
            // guessing a berth.
            db.MarineLocationAliases.Add(new MarineLocationAlias
            {
                Alias = alias,
                MarineLocationId = null,
                ResolutionHint = "vessel_home_berth",
            });
            report.AmbiguousAliases++;
            Console.WriteLine($"    alias '{alias}' -> '{target}' is ambiguous; stored for per-vessel resolution");
        }
        report.Aliases++;
    }
    await db.SaveChangesAsync();
    Console.WriteLine($"    {report.Locations} locations, {report.Aliases} aliases");
}

static async Task ImportVesselsAsync(DwoDbContext db, string dataPath, ImportReport report)
{
    Console.WriteLine("==> Vessels");
    var json = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(dataPath, "vessels.json")))!;
    var byCode = await db.MarineLocations.ToDictionaryAsync(x => x.LocationCode, x => x.Id);

    // MMSI lives in config.example.js and the AIS files rather than vessels.json.
    // Kept here so the import is self-contained; it moves to the Admin screen
    // once vessels are editable in the UI.
    var mmsiByCode = new Dictionary<string, string>
    {
        ["JUNO"] = "636025030", ["CA1"] = "538010097",
        ["CA3"] = "538010098",  ["CA5"] = "538010099",
        // CH3 has no MMSI on record yet - left null rather than invented.
    };

    var arr = json["vessels"]!.AsArray();

    // Two passes: ReplacedVesselID is a self-reference, so every row must exist
    // before any of them can point at another.
    foreach (var node in arr)
    {
        var code = node!["id"]!.GetValue<string>();
        int? homeBerthId = null;
        if (node["home_berth"]?.GetValue<string>() is { } hb && byCode.TryGetValue(hb, out var hbId))
            homeBerthId = hbId;

        db.Vessels.Add(new Vessel
        {
            VesselCode = code,
            VesselName = node["name"]!.GetValue<string>(),
            VesselType = node["type"]?.GetValue<string>(),
            LengthM    = node["length_m"]?.GetValue<decimal>(),
            BeamM      = node["beam_m"]?.GetValue<decimal>(),
            SpeedKts   = node["speed_kts"]?.GetValue<decimal>(),
            HomeBerthLocationId = homeBerthId,
            Mmsi       = mmsiByCode.GetValueOrDefault(code),
            MapColor   = node["color"]?.GetValue<string>(),
            MapStroke  = node["stroke"]?.GetValue<string>(),
            ActiveFrom = ParseDate(node["active_from"]?.GetValue<string>()),
            RetiredOn  = ParseDate(node["retired_on"]?.GetValue<string>()),
            SpecsProvisional = node["specs_provisional"]?.GetValue<bool>() ?? false,
            Notes      = node["$comment"]?.GetValue<string>(),
        });
        report.Vessels++;
    }
    await db.SaveChangesAsync();

    var vesselsByCode = await db.Vessels.ToDictionaryAsync(x => x.VesselCode);
    foreach (var node in arr)
    {
        if (node!["replaced_vessel"]?.GetValue<string>() is not { } replaced) continue;
        vesselsByCode[node["id"]!.GetValue<string>()].ReplacedVesselId = vesselsByCode[replaced].Id;
    }
    await db.SaveChangesAsync();
    Console.WriteLine($"    {report.Vessels} vessels");
}

static async Task ImportDailyReportsAsync(DwoDbContext db, string dataPath, ImportReport report)
{
    Console.WriteLine("==> Daily reports");
    var dir = Path.Combine(dataPath, "daily-reports");
    var vessels = await db.Vessels.ToDictionaryAsync(x => x.VesselCode, x => x.Id);
    var locs = await db.MarineLocations.ToDictionaryAsync(x => x.LocationCode, x => x.Id);

    int? LookupLoc(JsonNode? n)
    {
        var code = n?.GetValue<string>();
        return code is not null && locs.TryGetValue(code, out var id) ? id : null;
    }

    foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(f => f))
    {
        // index.json is a generated listing, not a report.
        if (Path.GetFileName(file) == "index.json") continue;

        var raw = await File.ReadAllTextAsync(file);
        var j = JsonNode.Parse(raw)!;

        var code = j["vessel_id"]?.GetValue<string>();
        if (code is null || !vessels.TryGetValue(code, out var vesselId))
        {
            report.Skipped.Add($"{Path.GetFileName(file)}: unknown vessel_id '{code}'");
            continue;
        }

        var src = j["source"];
        var r = new VesselDailyReport
        {
            VesselId   = vesselId,
            ReportDate = ParseDate(j["report_date"]!.GetValue<string>())!.Value,
            PeriodEnd  = j["period_end"]?.GetValue<string>(),
            VoyageNo   = j["voyage_no"]?.GetValue<string>(),
            CompiledByName = j["compiled_by"]?["name"]?.GetValue<string>(),
            CompiledByRole = j["compiled_by"]?["role"]?.GetValue<string>(),
            SubmittedAt    = ParseDateTime(j["compiled_by"]?["submitted_at"]?.GetValue<string>()),
            SafetyAccidents = j["safety"]?["accidents"]?.GetValue<string>(),
            SafetyIncidents = j["safety"]?["incidents"]?.GetValue<string>(),
            SafetyNearMiss  = j["safety"]?["near_miss"]?.GetValue<string>(),
            DaysSincePortCall = AsInt(j["days_since_port_call"]),
            SecurityLevel     = AsInt(j["security_level"]),
            NextCrewChange    = AsText(j["next_crew_change"]),
            IssuesComments    = j["issues_comments"]?.GetValue<string>(),
            AccidentSummary   = j["accident_summary"]?.GetValue<string>(),
            SourceType         = src?["type"]?.GetValue<string>(),
            SourceEmailSubject = src?["email_subject"]?.GetValue<string>(),
            SourceEmailFrom    = src?["email_from"]?.GetValue<string>(),
            SourceEmailDate    = ParseDateTime(src?["email_date"]?.GetValue<string>()),
            SourceAttachment   = src?["attachment_name"]?.GetValue<string>(),
            SourceSubmittedVia = src?["submitted_via"]?.GetValue<string>(),
            RawJson    = raw,
            CreatedOn  = DateTime.UtcNow.AddHours(3),   // Kuwait local
        };

        var order = 0;
        foreach (var t in j["task_log"]?.AsArray() ?? [])
        {
            r.Tasks.Add(new VesselReportTask
            {
                SortOrder   = order++,
                FromTime    = t!["from_time"]?.GetValue<string>(),
                ToTime      = t["to_time"]?.GetValue<string>(),
                DurationMin = AsInt(t["duration_min"]),
                TaskCode    = t["task_code"]?.GetValue<string>(),
                TaskLabel   = t["task_label"]?.GetValue<string>(),
                Description = t["description"]?.GetValue<string>(),
                LocationId     = LookupLoc(t["location_id"]),
                FromLocationId = LookupLoc(t["from_location_id"]),
                ToLocationId   = LookupLoc(t["to_location_id"]),
            });
            report.Tasks++;
        }

        var cOrder = 0;
        foreach (var kv in j["consumables"]?.AsObject() ?? [])
        {
            if (kv.Value is JsonObject row)
            {
                r.Consumables.Add(BuildConsumable(kv.Key, null, cOrder++, row));
                report.Consumables++;
            }
            else if (kv.Value is JsonArray rows)
            {
                // 'tanks' and 'mud' are lists of labelled rows on the PSVs.
                foreach (var item in rows.OfType<JsonObject>())
                {
                    r.Consumables.Add(BuildConsumable(kv.Key, item["label"]?.GetValue<string>(), cOrder++, item));
                    report.Consumables++;
                }
            }
        }

        var pOrder = 0;
        foreach (var c in j["crew"]?.AsArray() ?? [])
        {
            r.Crew.Add(BuildPerson("crew", pOrder++, c!));
            report.Crew++;
        }
        pOrder = 0;
        foreach (var p in j["passengers"]?.AsArray() ?? [])
        {
            r.Crew.Add(BuildPerson("passenger", pOrder++, p!));
            report.Crew++;
        }

        db.VesselDailyReports.Add(r);
        report.Reports++;
    }

    await db.SaveChangesAsync();
    Console.WriteLine($"    {report.Reports} reports, {report.Tasks} tasks, " +
                      $"{report.Consumables} consumables, {report.Crew} crew/pax");
}

static VesselReportConsumable BuildConsumable(string key, string? label, int order, JsonObject row) => new()
{
    ConsumableKey   = key,
    Label           = label,
    SortOrder       = order,
    MaxCapacity     = AsText(row["max_capacity"]),
    Consumed        = AsText(row["consumed"]),
    Loaded          = AsText(row["loaded"]),
    Discharged      = AsText(row["discharged"]),
    Rob             = AsText(row["rob"]),
    RemainingToLoad = AsText(row["remaining_to_load"]),
    Remarks         = AsText(row["remarks"]),
};

static VesselReportCrew BuildPerson(string type, int order, JsonNode n) => new()
{
    PersonType        = type,
    SortOrder         = order,
    FirstName         = AsText(n["first"]),
    LastName          = AsText(n["last"]),
    Position          = AsText(n["position"]),
    DaysOnboard       = AsText(n["days_onboard"]),
    SignOnDate        = AsText(n["sign_on_date"]),
    PlannedCrewChange = AsText(n["planned_crew_change"]),
};

// plans.json - the curated structure the map animates.
static async Task ImportStructuredPlansAsync(DwoDbContext db, string dataPath, ImportReport report)
{
    Console.WriteLine("==> Movement plans (structured)");
    var file = Path.Combine(dataPath, "plans.json");
    if (!File.Exists(file)) { Console.WriteLine("    plans.json not found - skipping"); return; }

    var j = JsonNode.Parse(await File.ReadAllTextAsync(file))!;
    var vessels = await db.Vessels.ToDictionaryAsync(x => x.VesselCode, x => x.Id);
    var locs = await db.MarineLocations.ToDictionaryAsync(x => x.LocationCode, x => x.Id);

    int? LookupLoc(JsonNode? n)
    {
        var code = n?.GetValue<string>();
        return code is not null && locs.TryGetValue(code, out var id) ? id : null;
    }

    foreach (var p in j["plans"]!.AsArray())
    {
        var plan = new MovementPlan
        {
            PlanDate   = ParseDate(p!["plan_date"]!.GetValue<string>())!.Value,
            SnapshotAt = ParseDateTime(p["snapshot_at"]?.GetValue<string>()),
            SourceType = "curated_structure",
            RawJson    = p.ToJsonString(),
            CreatedOn  = DateTime.UtcNow.AddHours(3),
        };

        foreach (var kv in p["snapshots"]?.AsObject() ?? [])
        {
            if (!vessels.TryGetValue(kv.Key, out var vid)) continue;
            plan.Snapshots.Add(new MovementPlanSnapshot
            {
                VesselId = vid,
                MarineLocationId = LookupLoc(kv.Value?["loc"]),
                RawText = AsText(kv.Value?["raw"]),
            });
            report.Snapshots++;
        }

        var order = 0;
        foreach (var m in p["movements"]?.AsArray() ?? [])
        {
            if (!vessels.TryGetValue(m!["vessel"]!.GetValue<string>(), out var vid)) continue;

            plan.Legs.Add(new MovementPlanLeg
            {
                VesselId  = vid,
                LegType   = "movement",
                SortOrder = order++,
                Etd       = ParseDateTime(m["etd"]?.GetValue<string>()),
                FromLocationId = LookupLoc(m["from"]),
                ToLocationId   = LookupLoc(m["to"]),
                ViaJson   = m["via"]?.ToJsonString(),
                Purpose   = AsText(m["purpose"]),
                RawText   = AsText(m["raw"]),
                EtdUncertain = m["etd_uncertain"]?.GetValue<bool>() ?? false,
                EtdSource    = AsText(m["etd_source"]),
            });
            report.Legs++;

            // A return leg becomes its own row so it can be edited on its own.
            // ParentLegID is wired after save, when the parent has an ID.
            if (m["return"] is JsonObject ret)
            {
                plan.Legs.Add(new MovementPlanLeg
                {
                    VesselId  = vid,
                    LegType   = "return",
                    SortOrder = order++,
                    FromLocationId = LookupLoc(m["to"]),      // returns from where the outbound ended
                    ToLocationId   = LookupLoc(ret["to"]),
                    ViaJson   = ret["via"]?.ToJsonString(),
                    RawText   = AsText(m["raw"]),
                });
                report.Legs++;
            }
        }

        db.MovementPlans.Add(plan);
        report.StructuredPlans++;
    }
    await db.SaveChangesAsync();

    // Second pass: link each 'return' row to the 'movement' row before it.
    foreach (var plan in await db.MovementPlans.Include(x => x.Legs).ToListAsync())
    {
        MovementPlanLeg? prev = null;
        foreach (var leg in plan.Legs.OrderBy(l => l.SortOrder))
        {
            if (leg.LegType == "return" && prev is { LegType: "movement" })
                leg.ParentLegId = prev.Id;
            prev = leg;
        }
    }
    await db.SaveChangesAsync();
    Console.WriteLine($"    {report.StructuredPlans} plans, {report.Snapshots} snapshots, {report.Legs} legs");
}

// movement-plans/*.json - the supervisor's narrative, as received.
static async Task ImportNarrativePlansAsync(DwoDbContext db, string dataPath, ImportReport report)
{
    Console.WriteLine("==> Movement plans (narrative)");
    var dir = Path.Combine(dataPath, "movement-plans");
    if (!Directory.Exists(dir)) { Console.WriteLine("    none - skipping"); return; }

    var vessels = await db.Vessels.ToDictionaryAsync(x => x.VesselCode, x => x.Id);
    var existing = await db.MovementPlans.ToDictionaryAsync(x => x.PlanDate);

    foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(f => f))
    {
        if (Path.GetFileName(file) == "index.json") continue;

        var raw = await File.ReadAllTextAsync(file);
        var j = JsonNode.Parse(raw)!;
        var planDate = ParseDate(j["plan_date"]!.GetValue<string>())!.Value;

        // The narrative and structured sources cover overlapping dates. Where a
        // date has both, they are two views of one plan and share a header.
        if (!existing.TryGetValue(planDate, out var plan))
        {
            plan = new MovementPlan { PlanDate = planDate, CreatedOn = DateTime.UtcNow.AddHours(3) };
            db.MovementPlans.Add(plan);
            existing[planDate] = plan;
            report.NarrativePlansNew++;
        }
        else
        {
            report.NarrativePlansMerged++;
        }

        var src = j["source"];
        plan.IssuedDate = ParseDate(j["issued_date"]?.GetValue<string>());
        plan.IssuedBy   = AsText(j["issued_by"]);
        plan.IssuedRole = AsText(j["issued_role"]);
        plan.Subject    = AsText(j["subject"]);
        plan.Narrative  = AsText(j["narrative"]);
        plan.SourceType = src?["type"]?.GetValue<string>() ?? plan.SourceType;
        plan.SourceEmailSubject = AsText(src?["email_subject"]);
        plan.SourceEmailFrom    = AsText(src?["email_from"]);
        plan.SourceEmailDate    = ParseDateTime(src?["email_date"]?.GetValue<string>());
        plan.SourceAttachment   = AsText(src?["attachment_name"]);
        plan.SourceSubmittedVia = AsText(src?["submitted_via"]);

        // A curated plan already wrote RawJson; keep both rather than overwrite.
        plan.RawJson = plan.RawJson is null
            ? raw
            : new JsonObject
              {
                  ["curated"] = JsonNode.Parse(plan.RawJson),
                  ["narrative_source"] = JsonNode.Parse(raw),
              }.ToJsonString();

        var order = 0;
        foreach (var v in j["vessels"]?.AsArray() ?? [])
        {
            var code = v!["vessel_id"]!.GetValue<string>();
            if (!vessels.TryGetValue(code, out var vid))
            {
                report.Skipped.Add($"{Path.GetFileName(file)}: unknown vessel_id '{code}'");
                continue;
            }
            plan.Vessels.Add(new MovementPlanVessel
            {
                VesselId      = vid,
                SortOrder     = order++,
                CurrentStatus = AsText(v["current_status"]),
                TomorrowPlan  = AsText(v["tomorrow_plan"]),
                Additional    = AsText(v["additional"]),
                Notes         = AsText(v["notes"]),
            });
            report.PlanVessels++;
        }
    }
    await db.SaveChangesAsync();
    Console.WriteLine($"    {report.NarrativePlansNew} new, {report.NarrativePlansMerged} merged into curated plans, " +
                      $"{report.PlanVessels} vessel bullets");
}

static async Task ImportAisAsync(DwoDbContext db, string dataPath, ImportReport report)
{
    Console.WriteLine("==> AIS history");
    var dir = Path.Combine(dataPath, "ais-history");
    if (!Directory.Exists(dir)) { Console.WriteLine("    none - skipping"); return; }

    var vessels = await db.Vessels.ToDictionaryAsync(x => x.VesselCode, x => x.Id);

    // One vessel can be covered by several files whose windows overlap, and the
    // table forbids duplicate (vessel, time, source). Dedupe in memory so the
    // import cannot trip its own unique index.
    var seen = new HashSet<(int, DateTime, string)>();

    foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(f => f))
    {
        if (Path.GetFileName(file) == "index.json") continue;

        var j = JsonNode.Parse(await File.ReadAllTextAsync(file))!;
        var code = j["vessel_id"]?.GetValue<string>();
        if (code is null || !vessels.TryGetValue(code, out var vid))
        {
            report.Skipped.Add($"{Path.GetFileName(file)}: unknown vessel_id '{code}'");
            continue;
        }

        var mmsi = AsText(j["mmsi"]);
        var provider = j["source"]?["provider"]?.GetValue<string>() ?? "import";

        foreach (var p in j["positions"]?.AsArray() ?? [])
        {
            // The feed publishes UTC; it is stored as UTC. See AisPosition's note.
            var ts = ParseDateTime(p!["ts"]!.GetValue<string>(), assumeUtc: true)!.Value;
            if (!seen.Add((vid, ts, provider))) { report.AisDuplicates++; continue; }

            db.AisPositions.Add(new AisPosition
            {
                VesselId     = vid,
                TimestampUtc = ts,
                Latitude     = p["lat"]!.GetValue<decimal>(),
                Longitude    = p["lon"]!.GetValue<decimal>(),
                SpeedKts     = AsDecimal(p["sog"]),
                CourseDeg    = AsDecimal(p["cog"]),
                HeadingDeg   = AsDecimal(p["heading"]),
                NavStatus    = AsText(p["nav_status"]),
                Mmsi         = mmsi,
                Source       = provider,
            });
            report.AisPositions++;
        }
    }
    await db.SaveChangesAsync();
    Console.WriteLine($"    {report.AisPositions} positions" +
                      (report.AisDuplicates > 0 ? $" ({report.AisDuplicates} duplicates collapsed)" : ""));
}

// -----------------------------------------------------------------------------
// Verification: compare what is in the database against the files on disk.
// An import that "succeeded" but silently dropped rows is the failure mode worth
// guarding against, so this counts both sides rather than trusting the inserts.
// -----------------------------------------------------------------------------
static async Task<bool> VerifyAsync(DwoDbContext db, string dataPath, ImportReport report)
{
    Console.WriteLine();
    Console.WriteLine("==> Verifying against source files");

    var reportFiles = Directory.GetFiles(Path.Combine(dataPath, "daily-reports"), "*.json")
        .Where(f => Path.GetFileName(f) != "index.json").ToList();

    var fileTasks = 0;
    var fileTasksWithLocation = 0;
    foreach (var f in reportFiles)
    {
        foreach (var t in JsonNode.Parse(await File.ReadAllTextAsync(f))!["task_log"]?.AsArray() ?? [])
        {
            fileTasks++;
            if (t!["location_id"] is not null) fileTasksWithLocation++;
        }
    }

    var fileVessels = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(dataPath, "vessels.json")))!
        ["vessels"]!.AsArray().Count;
    var fileLocs = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(dataPath, "locations.json")))!
        ["locations"]!.AsArray().Count;

    var fileAis = 0;
    var aisKeys = new HashSet<(string, string, string)>();
    foreach (var f in Directory.GetFiles(Path.Combine(dataPath, "ais-history"), "*.json"))
    {
        if (Path.GetFileName(f) == "index.json") continue;
        var j = JsonNode.Parse(await File.ReadAllTextAsync(f))!;
        var vid = j["vessel_id"]!.GetValue<string>();
        var prov = j["source"]?["provider"]?.GetValue<string>() ?? "import";
        foreach (var p in j["positions"]!.AsArray())
            if (aisKeys.Add((vid, p!["ts"]!.GetValue<string>(), prov))) fileAis++;
    }

    var checks = new List<(string Name, int Db, int File)>
    {
        ("vessels",       await db.Vessels.CountAsync(),            fileVessels),
        ("locations",     await db.MarineLocations.CountAsync(),    fileLocs),
        ("daily reports", await db.VesselDailyReports.CountAsync(), reportFiles.Count),
        ("report tasks",  await db.VesselReportTasks.CountAsync(),  fileTasks),
        ("ais positions", await db.AisPositions.CountAsync(),       fileAis),
    };

    var ok = true;
    foreach (var (name, dbCount, fileCount) in checks)
    {
        var pass = dbCount == fileCount;
        ok &= pass;
        Console.WriteLine($"    [{(pass ? "OK" : "FAIL")}] {name,-14} db={dbCount,-6} files={fileCount}");
    }

    // Every task that names a location must have resolved to one. A silent null
    // here would put a vessel nowhere on the map.
    var dbTasksWithLocation = await db.VesselReportTasks.CountAsync(t => t.LocationId != null);
    var locsOk = dbTasksWithLocation == fileTasksWithLocation;
    ok &= locsOk;
    Console.WriteLine($"    [{(locsOk ? "OK" : "FAIL")}] task locations db={dbTasksWithLocation,-6} files={fileTasksWithLocation}");

    // Values, not just counts.
    //
    // Row counts alone once passed this import while every latitude was being
    // silently rounded from 28.912411 to 28.91 - a kilometre of error, correct
    // count, clean run. Coordinates are the data most likely to be quietly
    // mangled by a type or precision mismatch and the least likely to look wrong
    // in a count, so they are compared exactly against the source.
    ok &= await VerifyCoordinatesAsync(db, dataPath);

    if (report.Skipped.Count > 0)
    {
        Console.WriteLine();
        Console.WriteLine($"    {report.Skipped.Count} skipped record(s):");
        foreach (var s in report.Skipped.Take(20)) Console.WriteLine($"      - {s}");
        ok = false;
    }

    Console.WriteLine();
    Console.WriteLine(ok ? "==> Import verified." : "==> VERIFICATION FAILED - see above.");
    return ok;
}

/// <summary>
/// Compares stored coordinates against the source files.
///
/// Reads with AsNoTracking so every value comes back from SQL Server. Without it
/// EF hands back the objects still in the change tracker - the ones this process
/// just built in memory - and the comparison checks the importer against itself.
/// That is not hypothetical: it is exactly how the decimal(18,2) rounding bug
/// passed a green verification run.
///
/// Coordinates are compared at the column's declared scale (7 decimal places,
/// about 1cm on the ground). The AIS feed publishes values like
/// 29.169391666666666; storing 29.1693917 is the intended, lossless-enough
/// rounding. Comparing raw equality would flag every one of those as a failure
/// and train the next reader to ignore this check.
/// </summary>
static async Task<bool> VerifyCoordinatesAsync(DwoDbContext db, string dataPath)
{
    const int Scale = 7;
    static decimal AtScale(decimal d) => Math.Round(d, Scale, MidpointRounding.ToEven);

    var ok = true;

    // Locations
    var srcLocs = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(dataPath, "locations.json")))!
        ["locations"]!.AsArray()
        .ToDictionary(n => n!["id"]!.GetValue<string>(),
                      n => (Lat: AtScale(n["lat"]!.GetValue<decimal>()),
                            Lon: AtScale(n["lon"]!.GetValue<decimal>())));

    var badLocs = new List<string>();
    var locsCompared = 0;
    foreach (var l in await db.MarineLocations.AsNoTracking().ToListAsync())
    {
        if (!srcLocs.TryGetValue(l.LocationCode, out var src)) continue;
        locsCompared++;
        if (AtScale(l.Latitude) != src.Lat || AtScale(l.Longitude) != src.Lon)
            badLocs.Add($"{l.LocationCode}: db=({l.Latitude},{l.Longitude}) file=({src.Lat},{src.Lon})");
    }
    ok &= badLocs.Count == 0 && locsCompared == srcLocs.Count;
    Console.WriteLine($"    [{(badLocs.Count == 0 && locsCompared == srcLocs.Count ? "OK" : "FAIL")}] " +
                      $"location coords  {locsCompared}/{srcLocs.Count} compared, {badLocs.Count} mismatched");
    foreach (var b in badLocs.Take(5)) Console.WriteLine($"           {b}");

    // AIS positions
    var srcAis = new Dictionary<(string, DateTime, string), (decimal Lat, decimal Lon)>();
    foreach (var f in Directory.GetFiles(Path.Combine(dataPath, "ais-history"), "*.json"))
    {
        if (Path.GetFileName(f) == "index.json") continue;
        var j = JsonNode.Parse(await File.ReadAllTextAsync(f))!;
        var vid = j["vessel_id"]!.GetValue<string>();
        var prov = j["source"]?["provider"]?.GetValue<string>() ?? "import";
        foreach (var p in j["positions"]!.AsArray())
        {
            var ts = DateTimeOffset.Parse(p!["ts"]!.GetValue<string>(),
                CultureInfo.InvariantCulture).UtcDateTime;
            srcAis.TryAdd((vid, ts, prov), (AtScale(p["lat"]!.GetValue<decimal>()),
                                            AtScale(p["lon"]!.GetValue<decimal>())));
        }
    }

    var badAis = new List<string>();
    var aisCompared = 0;
    foreach (var p in await db.AisPositions.AsNoTracking().Include(x => x.Vessel).ToListAsync())
    {
        var key = (p.Vessel!.VesselCode, p.TimestampUtc, p.Source);
        if (!srcAis.TryGetValue(key, out var src)) continue;
        aisCompared++;
        if (AtScale(p.Latitude) != src.Lat || AtScale(p.Longitude) != src.Lon)
            badAis.Add($"{p.Vessel.VesselCode} {p.TimestampUtc:u}: db=({p.Latitude},{p.Longitude}) file=({src.Lat},{src.Lon})");
    }
    // Every stored position must have been matched to a source row; a shortfall
    // means the keys drifted and the comparison silently skipped rows.
    var aisOk = badAis.Count == 0 && aisCompared == srcAis.Count;
    ok &= aisOk;
    Console.WriteLine($"    [{(aisOk ? "OK" : "FAIL")}] ais coords       {aisCompared}/{srcAis.Count} compared, {badAis.Count} mismatched");
    foreach (var b in badAis.Take(5)) Console.WriteLine($"           {b}");

    return ok;
}

// -----------------------------------------------------------------------------

static DateOnly? ParseDate(string? s) =>
    string.IsNullOrWhiteSpace(s) ? null
    : DateOnly.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;

/// <summary>
/// Parses a timestamp. When <paramref name="assumeUtc"/> is set (the AIS feed) the
/// value is converted to UTC; otherwise it is kept exactly as written, because
/// report and plan times are Kuwait local and carry no offset in the source.
/// </summary>
static DateTime? ParseDateTime(string? s, bool assumeUtc = false)
{
    if (string.IsNullOrWhiteSpace(s)) return null;
    if (!DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dto))
        return null;
    return assumeUtc ? dto.UtcDateTime : dto.DateTime;
}

// The source JSON is not consistently typed: days_onboard and similar fields are
// sometimes a number and sometimes a string. These readers take either rather
// than throwing on the file that happens to differ.
static string? AsText(JsonNode? n) => n?.GetValueKind() switch
{
    null or JsonValueKind.Null => null,
    JsonValueKind.String => n.GetValue<string>(),
    _ => n.ToJsonString().Trim('"'),
};

static int? AsInt(JsonNode? n) => n?.GetValueKind() switch
{
    null or JsonValueKind.Null => null,
    JsonValueKind.Number => n.GetValue<int>(),
    JsonValueKind.String => int.TryParse(n.GetValue<string>(), out var i) ? i : null,
    _ => null,
};

static decimal? AsDecimal(JsonNode? n) => n?.GetValueKind() switch
{
    null or JsonValueKind.Null => null,
    JsonValueKind.Number => n.GetValue<decimal>(),
    JsonValueKind.String => decimal.TryParse(n.GetValue<string>(), NumberStyles.Any,
        CultureInfo.InvariantCulture, out var d) ? d : null,
    _ => null,
};

internal class ImportReport
{
    public int Locations, Aliases, AmbiguousAliases, Vessels;
    public int Reports, Tasks, Consumables, Crew;
    public int StructuredPlans, Snapshots, Legs;
    public int NarrativePlansNew, NarrativePlansMerged, PlanVessels;
    public int AisPositions, AisDuplicates;
    public List<string> Skipped = [];
}
