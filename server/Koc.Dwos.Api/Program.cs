using Koc.Dwos.Api.Hubs;
using Koc.Dwos.Api.Services;
using Koc.Dwos.Infrastructure;
using Microsoft.AspNetCore.Authentication.Negotiate;
using Microsoft.EntityFrameworkCore;

// Content root pinned to the binary's own folder, not the working directory.
// Without this, `dotnet publish/Koc.Dwos.Api.dll` run from anywhere else
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
//   set -a; source keys.env; set +a; dotnet run --project server/Koc.Dwos.Api
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

var authMode = builder.Configuration["Auth:Mode"] ?? "Disabled";
if (authMode == "Windows")
{
    builder.Services
        .AddAuthentication(NegotiateDefaults.AuthenticationScheme)
        .AddNegotiate();
    builder.Services.AddAuthorization(o =>
    {
        // Everything requires auth unless an endpoint opts out explicitly.
        o.FallbackPolicy = o.DefaultPolicy;
    });
}
else
{
    builder.Services.AddAuthorization();
}

var app = builder.Build();

if (authMode != "Windows")
{
    app.Logger.LogWarning(
        "AUTH IS DISABLED (Auth__Mode={Mode}). Local development only — " +
        "set Auth__Mode=Windows in any deployed environment.", authMode);
}


if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
    app.UseCors(DevCors);
}

// Authentication: Windows/AD, per the KOC developer's answer (2026-08-16).
// Negotiate handles Kerberos/NTLM when self-hosted; under IIS with Windows
// Authentication enabled the identity arrives from IIS itself and this handler
// steps aside. The Windows identity is then matched to dbo.[User].Username and
// privileges resolve through UserPrivilege and UserRole -> RolePrivilege — see
// Modules/Platform/MeController.
//
// Auth__Mode environment variable:
//   Windows   production. Every endpoint requires an authenticated user except
//             /api/health (monitoring) and /api/me (which reports auth state).
//   Disabled  local development default — macOS has no AD to negotiate with.
//             Loudly logged so it can never be mistaken for a production state.
if (authMode == "Windows")
{
    app.UseAuthentication();
    app.UseAuthorization();
}

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
})).AllowAnonymous();

app.Run();
