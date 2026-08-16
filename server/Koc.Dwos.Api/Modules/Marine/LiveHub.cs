using Microsoft.AspNetCore.SignalR;

namespace Koc.Dwos.Api.Hubs;

/// <summary>
/// Push channel to connected dashboards. Replaces the SSE endpoint the Node
/// server exposed at /api/stream.
///
/// Events (method names the client subscribes to):
///   report_saved   { vessel_id, report_date }
///   plan_saved     { plan_date }
///   live_position  { vessel_id, lat, lon, sog, cog, heading, ts, mmsi }
///   live_status    { running, interval_ms, last_poll, message }
/// </summary>
public class LiveHub : Hub;

public static class LiveEvents
{
    public const string ReportSaved  = "report_saved";
    public const string PlanSaved    = "plan_saved";
    public const string LivePosition = "live_position";
    public const string LiveStatus   = "live_status";
}
