using System.Text.Json.Nodes;
using Koc.Vessels.Domain;
using Koc.Vessels.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Koc.Vessels.Api.Services;

/// <summary>
/// Writes a daily report or movement plan submitted as JSON.
///
/// The document IS the payload: RawJson always holds the current, complete
/// submission, and the relational columns are a projection of it kept in step on
/// every write. Readers that want the exact shape the old file-backed API served
/// read RawJson; readers that want to filter or sort use the columns. Letting
/// the two drift is the one thing that would break that contract, so both are
/// written together in one transaction.
/// </summary>
public class ReportWriter(DwoDbContext db)
{
    public async Task<(bool Ok, string? Error)> SaveReportAsync(JsonNode body, CancellationToken ct = default)
    {
        var code = body["vessel_id"]?.GetValue<string>();
        var dateText = body["report_date"]?.GetValue<string>();

        if (string.IsNullOrWhiteSpace(code)) return (false, "vessel_id is required");
        if (string.IsNullOrWhiteSpace(dateText)) return (false, "report_date is required");
        if (!DateOnly.TryParse(dateText, out var reportDate)) return (false, "report_date must be YYYY-MM-DD");

        var vessel = await db.Vessels.FirstOrDefaultAsync(v => v.VesselCode == code, ct);
        if (vessel is null) return (false, $"unknown vessel_id '{code}'");

        if (body["task_log"] is not JsonArray) return (false, "task_log is required");

        var locs = await db.MarineLocations.ToDictionaryAsync(x => x.LocationCode, x => x.Id, ct);
        int? LookupLoc(JsonNode? n)
        {
            var c = n?.GetValueKind() == System.Text.Json.JsonValueKind.String ? n.GetValue<string>() : null;
            return c is not null && locs.TryGetValue(c, out var id) ? id : null;
        }

        await using var tx = await db.Database.BeginTransactionAsync(ct);

        var existing = await db.VesselDailyReports
            .Include(r => r.Tasks).Include(r => r.Consumables).Include(r => r.Crew)
            .FirstOrDefaultAsync(r => r.VesselId == vessel.Id && r.ReportDate == reportDate, ct);

        var report = existing ?? new VesselDailyReport
        {
            VesselId = vessel.Id,
            ReportDate = reportDate,
            CreatedOn = KuwaitNow,
        };

        if (existing is not null)
        {
            // Re-submission replaces the children outright. Diffing task rows
            // against a re-parsed PDF would be guesswork; the document is the
            // unit of truth, so the projection is rebuilt from it.
            db.VesselReportTasks.RemoveRange(existing.Tasks);
            db.VesselReportConsumables.RemoveRange(existing.Consumables);
            db.VesselReportCrew.RemoveRange(existing.Crew);
            existing.Tasks.Clear();
            existing.Consumables.Clear();
            existing.Crew.Clear();
            report.ModifiedOn = KuwaitNow;
        }

        var src = body["source"];
        report.PeriodEnd = Text(body["period_end"]);
        report.VoyageNo = Text(body["voyage_no"]);
        report.CompiledByName = Text(body["compiled_by"]?["name"]);
        report.CompiledByRole = Text(body["compiled_by"]?["role"]);
        report.SubmittedAt = Time(body["compiled_by"]?["submitted_at"]);
        report.SafetyAccidents = Text(body["safety"]?["accidents"]);
        report.SafetyIncidents = Text(body["safety"]?["incidents"]);
        report.SafetyNearMiss = Text(body["safety"]?["near_miss"]);
        report.DaysSincePortCall = Int(body["days_since_port_call"]);
        report.SecurityLevel = Int(body["security_level"]);
        report.NextCrewChange = Text(body["next_crew_change"]);
        report.IssuesComments = Text(body["issues_comments"]);
        report.AccidentSummary = Text(body["accident_summary"]);
        report.SourceType = Text(src?["type"]);
        report.SourceEmailSubject = Text(src?["email_subject"]);
        report.SourceEmailFrom = Text(src?["email_from"]);
        report.SourceEmailDate = Time(src?["email_date"]);
        report.SourceAttachment = Text(src?["attachment_name"]);
        report.SourceSubmittedVia = Text(src?["submitted_via"]);
        report.RawJson = body.ToJsonString();

        var order = 0;
        foreach (var t in body["task_log"]!.AsArray())
        {
            report.Tasks.Add(new VesselReportTask
            {
                SortOrder = order++,
                FromTime = Text(t!["from_time"]),
                ToTime = Text(t["to_time"]),
                DurationMin = Int(t["duration_min"]),
                TaskCode = Text(t["task_code"]),
                TaskLabel = Text(t["task_label"]),
                Description = Text(t["description"]),
                LocationId = LookupLoc(t["location_id"]),
                FromLocationId = LookupLoc(t["from_location_id"]),
                ToLocationId = LookupLoc(t["to_location_id"]),
            });
        }

        var cOrder = 0;
        foreach (var kv in body["consumables"]?.AsObject() ?? [])
        {
            if (kv.Value is JsonObject row)
                report.Consumables.Add(Consumable(kv.Key, null, cOrder++, row));
            else if (kv.Value is JsonArray rows)
                foreach (var item in rows.OfType<JsonObject>())
                    report.Consumables.Add(Consumable(kv.Key, Text(item["label"]), cOrder++, item));
        }

        var pOrder = 0;
        foreach (var c in body["crew"]?.AsArray() ?? []) report.Crew.Add(Person("crew", pOrder++, c!));
        pOrder = 0;
        foreach (var p in body["passengers"]?.AsArray() ?? []) report.Crew.Add(Person("passenger", pOrder++, p!));

        if (existing is null) db.VesselDailyReports.Add(report);

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> SavePlanAsync(JsonNode body, CancellationToken ct = default)
    {
        var dateText = body["plan_date"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(dateText)) return (false, "plan_date is required");
        if (!DateOnly.TryParse(dateText, out var planDate)) return (false, "plan_date must be YYYY-MM-DD");
        if (body["vessels"] is not JsonArray vesselsArr || vesselsArr.Count == 0)
            return (false, "vessels must be a non-empty array");

        var vessels = await db.Vessels.ToDictionaryAsync(x => x.VesselCode, x => x.Id, ct);

        await using var tx = await db.Database.BeginTransactionAsync(ct);

        var plan = await db.MovementPlans.Include(p => p.Vessels)
            .FirstOrDefaultAsync(p => p.PlanDate == planDate, ct);

        if (plan is null)
        {
            plan = new MovementPlan { PlanDate = planDate, CreatedOn = KuwaitNow };
            db.MovementPlans.Add(plan);
        }
        else
        {
            db.MovementPlanVessels.RemoveRange(plan.Vessels);
            plan.Vessels.Clear();
            plan.ModifiedOn = KuwaitNow;
        }

        var src = body["source"];
        plan.IssuedDate = body["issued_date"]?.GetValue<string>() is { } d && DateOnly.TryParse(d, out var id2)
            ? id2 : null;
        plan.IssuedBy = Text(body["issued_by"]);
        plan.IssuedRole = Text(body["issued_role"]);
        plan.Subject = Text(body["subject"]);
        plan.Narrative = Text(body["narrative"]);
        plan.SourceType = Text(src?["type"]);
        plan.SourceEmailSubject = Text(src?["email_subject"]);
        plan.SourceEmailFrom = Text(src?["email_from"]);
        plan.SourceEmailDate = Time(src?["email_date"]);
        plan.SourceAttachment = Text(src?["attachment_name"]);
        plan.SourceSubmittedVia = Text(src?["submitted_via"]);
        plan.RawJson = body.ToJsonString();

        var order = 0;
        foreach (var v in vesselsArr)
        {
            var code = v!["vessel_id"]?.GetValue<string>();
            if (code is null || !vessels.TryGetValue(code, out var vid))
                return (false, $"unknown vessel_id '{code}'");

            plan.Vessels.Add(new MovementPlanVessel
            {
                VesselId = vid,
                SortOrder = order++,
                CurrentStatus = Text(v["current_status"]),
                TomorrowPlan = Text(v["tomorrow_plan"]),
                Additional = Text(v["additional"]),
                Notes = Text(v["notes"]),
            });
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return (true, null);
    }

    // Reports and plans are Kuwait local everywhere; see 002-marine-tables.sql.
    private static DateTime KuwaitNow => DateTime.UtcNow.AddHours(3);

    private static VesselReportConsumable Consumable(string key, string? label, int order, JsonObject row) => new()
    {
        ConsumableKey = key,
        Label = label,
        SortOrder = order,
        MaxCapacity = Text(row["max_capacity"]),
        Consumed = Text(row["consumed"]),
        Loaded = Text(row["loaded"]),
        Discharged = Text(row["discharged"]),
        Rob = Text(row["rob"]),
        RemainingToLoad = Text(row["remaining_to_load"]),
        Remarks = Text(row["remarks"]),
    };

    private static VesselReportCrew Person(string type, int order, JsonNode n) => new()
    {
        PersonType = type,
        SortOrder = order,
        FirstName = Text(n["first"]),
        LastName = Text(n["last"]),
        Position = Text(n["position"]),
        DaysOnboard = Text(n["days_onboard"]),
        SignOnDate = Text(n["sign_on_date"]),
        PlannedCrewChange = Text(n["planned_crew_change"]),
    };

    // The submitted JSON is not consistently typed - a field that is a number in
    // one report is a string in the next. These take either.
    private static string? Text(JsonNode? n) => n?.GetValueKind() switch
    {
        null or System.Text.Json.JsonValueKind.Null => null,
        System.Text.Json.JsonValueKind.String => n.GetValue<string>(),
        _ => n.ToJsonString().Trim('"'),
    };

    private static int? Int(JsonNode? n) => n?.GetValueKind() switch
    {
        System.Text.Json.JsonValueKind.Number => n.GetValue<int>(),
        System.Text.Json.JsonValueKind.String => int.TryParse(n.GetValue<string>(), out var i) ? i : null,
        _ => null,
    };

    private static DateTime? Time(JsonNode? n) =>
        Text(n) is { } s && DateTimeOffset.TryParse(s, out var dto) ? dto.DateTime : null;
}
