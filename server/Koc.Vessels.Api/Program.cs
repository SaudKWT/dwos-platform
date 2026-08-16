using Koc.Vessels.Api.Hubs;
using Koc.Vessels.Api.Services;
using Koc.Vessels.Infrastructure;
using Microsoft.EntityFrameworkCore;

// Content root pinned to the binary's own folder, not the working directory.
// Without this, `dotnet publish/Koc.Vessels.Api.dll` run from anywhere else
// serves the API perfectly and 404s the entire SPA — wwwroot resolves against
// CWD. IIS sets content root itself, so the bug only appears in exactly the
// environments where nobody is looking: a console run, a service, a smoke test.
// Found by running the published artifact from the repo root on 2026-08-13.
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});

// keys.env supplies ConnectionStrings__Dwo. Environment variables are already in
// the default configuration chain, so nothing else is needed:
//   set -a; source keys.env; set +a; dotnet run --project server/Koc.Vessels.Api
var conn = builder.Configuration.GetConnectionString("Dwo");
if (string.IsNullOrWhiteSpace(conn))
    throw new InvalidOperationException(
        "ConnectionStrings__Dwo is not set. Run: set -a; source keys.env; set +a");

builder.Services.AddDbContext<DwoDbContext>(o => o.UseSqlServer(conn));
builder.Services.AddScoped<ReportWriter>();
builder.Services.AddControllers()
    // The payloads are documents, not DTOs: they carry vessel-specific fields no
    // C# type models. Preserving the author's property names keeps what we hand
    // back identical to what was submitted.
    .AddJsonOptions(o => o.JsonSerializerOptions.PropertyNamingPolicy = null);
builder.Services.AddSignalR();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// The React dev server runs on another port, and SignalR needs credentials
// allowed. Dev origins only - in production the built client is served from this
// same app, so there is no cross-origin request to permit.
const string DevCors = "dev";
builder.Services.AddCors(o => o.AddPolicy(DevCors, p => p
    // web/ runs on 4200. These are a fallback: Vite proxies /api, so the browser
    // is same-origin in dev and CORS never fires. They matter only when someone
    // points the client at the API directly, without the proxy.
    .WithOrigins("http://localhost:4200", "http://127.0.0.1:4200",
                 "http://localhost:4201", "http://127.0.0.1:4201")
    .AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
    app.UseCors(DevCors);
}

// Access is deliberately open: the authentication decision was deferred. The
// legacy schema's User/Role/Privilege tables are in place for it and the JWT
// work drops in here. Do not expose this beyond a local network as it stands.
app.MapControllers();
app.MapHub<LiveHub>("/hubs/live");

// Serves the built React client in production. publish.sh performs the
// web/dist -> wwwroot copy; nothing else does.
app.UseDefaultFiles();
app.UseStaticFiles();

// The client is a single-page app with real routes — /unit-4/vessels/reports is
// a client-side path, not a file on disk. Without this, a deep link or a refresh
// on any screen but the root returns 404 from the static handler. The fallback is
// registered AFTER MapControllers so it never shadows an /api route.
app.MapFallbackToFile("index.html");

app.MapGet("/api/health", async (DwoDbContext db) => Results.Ok(new
{
    ok = true,
    database = await db.Database.CanConnectAsync(),
    vessels = await db.Vessels.CountAsync(),
    reports = await db.VesselDailyReports.CountAsync(),
}));

app.Run();
