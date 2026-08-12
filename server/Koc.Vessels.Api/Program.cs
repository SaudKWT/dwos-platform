using Koc.Vessels.Api.Hubs;
using Koc.Vessels.Api.Services;
using Koc.Vessels.Infrastructure;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

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
    .WithOrigins("http://localhost:5173", "http://127.0.0.1:5173",
                 "http://localhost:5174", "http://127.0.0.1:5174")
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

// Serves the built React client (client/dist copied to wwwroot) in production.
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/health", async (DwoDbContext db) => Results.Ok(new
{
    ok = true,
    database = await db.Database.CanConnectAsync(),
    vessels = await db.Vessels.CountAsync(),
    reports = await db.VesselDailyReports.CountAsync(),
}));

app.Run();
