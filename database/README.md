# Database

The app runs on SQL Server, database `DWO`.

## Scripts

They apply in filename order. `migrate.sh` records each one in `dbo.SchemaVersions`
and never runs it twice.

| Script | What it is |
| --- | --- |
| `000-create-database.sql` | Creates `DWO` if missing. No-op on a server that already has it. Always runs; self-guarding. |
| `001-schema0726.sql` | **The corporate drilling schema, exactly as delivered** (43 tables: users, privileges, assets, wells, rigs, drilling, workover, budgets). Converted from UTF-16 to UTF-8 and nothing else. Do not edit it — if it stops matching the DBA's file, comparing the two later becomes guesswork. |
| `002-marine-tables.sql` | Our 12 vessel-movement tables. Additive only. |

## Why there are two kinds of table

`schema0726.sql` has no concept of a vessel, a movement plan, a daily report or an
AIS position — it is the drilling database. So `002` adds what the app needs, in the
same house style (`dbo`, `int IDENTITY` primary key named `ID`, `IsActive`/`IsDeleted`
flags).

The legacy tables are treated as **read-only**. They may be shared with other
corporate systems, so nothing here alters or drops one. Foreign keys point *into*
that schema (`MarineLocation.RigID` → `dbo.Rig`) but never constrain it.

What we read from the legacy side: `Rig` and `Well` (offshore destinations),
`Contractor` (vessel owners), and `User`/`Role`/`Privilege` when authentication is
switched on.

## Time zones

Reports and plans are **Kuwait local (UTC+3)** — the convention of the source PDFs,
of every JSON file, and of the legacy schema itself (`dbo.Log.Timestamp` defaults to
`getdate()+3h`).

**AIS positions are UTC**, because the feed publishes UTC. Those columns are suffixed
`Utc`. Never mix the two in one column.

## Local setup

SQL Server has no native macOS build, so it runs in a container. The image is amd64
only, so on Apple Silicon it needs Rosetta. Either runtime works:

```bash
# Docker Desktop — enable Settings ▸ General ▸ "Use Rosetta for x86/amd64 emulation"
# or colima:
brew install colima docker docker-compose
colima start --vm-type=vz --vz-rosetta --cpu 2 --memory 4 --disk 20
```

Then, from the repo root:

```bash
docker compose --env-file keys.env up -d   # start SQL Server (container: dwos-sql)
./database/migrate.sh                      # apply the schema
./database/migrate.sh --status             # show applied / pending
```

Verified end to end on 2026-08-12: Docker Desktop 29.2.1 on arm64 under Rosetta,
`mcr.microsoft.com/mssql/server:2022-latest`, healthy in 20s. All five scripts applied
clean — 56 tables, 30 foreign keys, one registered module.

`keys.env` is untracked and holds `MSSQL_SA_PASSWORD`. Create it before the first run;
any strong password will do, it is local only.

Credentials live in `keys.env` at the repo root (untracked, `chmod 600`). Values there
are single-quoted because the connection string contains `;` and spaces, which bash
would otherwise try to execute when the file is sourced.

## Loading the data

```bash
set -a; source keys.env; set +a
dotnet run --project server/Koc.Dwos.Importer               # wipe + reload from data/*.json
dotnet run --project server/Koc.Dwos.Importer -- --verify-only
```

The importer is re-runnable and verifies itself against the source files afterwards —
row counts **and** coordinate values. The value check earns its keep: row counts alone
once passed a run in which every latitude was silently rounded from `28.912411` to
`28.91` (a kilometre of error) by EF Core's default `decimal(18,2)`. Any new `decimal`
property needs a matching `HasPrecision` in `DwoDbContext`.

## Loading the data where the importer cannot run

`seed-marine-data.sql` is the same data as one plain T-SQL file, for a server that
offers no .NET and no path for the importer to connect — the KOC cluster is loaded by
handing the DBA this file. It DELETEs the marine tables child-first and re-INSERTs
them with identities preserved, so it is re-runnable and every foreign key matches.
It never touches a `001-schema0726.sql` table, and it sits outside `migrate.sh`'s
numbered glob on purpose: it is data, not schema, and wants re-running rather than
journalling.

```bash
sqlcmd -S <server> -d DWO -E -i seed-marine-data.sql   # after 000..004
```

It is **generated — do not edit it**. The importer emits it only after its own
verification passes, with `--emit-seed`:

```bash
dotnet run --project server/Koc.Dwos.Importer -- --data reference/data \
  --emit-seed database/seed-marine-data.sql
```

To prove a copy is faithful, apply it locally and run the importer with
`--verify-only`: the script is then held to the same row-count and coordinate
checks as a direct import. Done for the shipped copy on 2026-08-30 — all checks OK,
including the 12 deferred self-references (`Vessel.ReplacedVesselID`,
`MovementPlanLeg.ParentLegID`) the verifier does not cover, checked by hand.
