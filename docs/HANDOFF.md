# DWOS Platform — handoff

For the in-house KOC developer taking this to KOC servers.

Drilling & Workover Operational Support Team. One database, one API, one web app
with a module per unit. Adding a unit's app is a folder and a config entry — not
a new repository, not a new database, not a new deployment.

```
database/   the schema and its migrations. The only home of either.
server/     the API. ASP.NET Core. Modules live inside it.
web/        the dashboard. AppShell + TeamConfig + a module per unit.
reference/  the DDR corpus, the PDF parsers, design notes. Source material,
            not part of the running system. Safe to leave undeployed.
```

## The one architectural decision to understand first

**One database, `DWO`, shared by every module.** Not one per app and not one per
team. The reason is in the corporate schema you were given:

`001-schema0726.sql` declares **no `UNIQUE` constraint anywhere** across its 43
tables — every table keys on `[ID] int IDENTITY`. So if two databases each held a
copy of `dbo.Well`, there is no natural key on which they could ever be
reconciled, and a stale `WellID` would silently return a different well's history
rather than failing. 27 of those 43 tables are shared reference or identity data;
only 16 are app-specific.

Splitting would also mean dropping five already-declared foreign keys, because
SQL Server has no cross-database foreign keys.

New modules go in `dbo` alongside everything else, or — preferred for anything
new — in their own SQL schema. See "Adding a module" below.

## What you need before you start

| | |
|---|---|
| SQL Server | version and instance **TBD — see Deployment** |
| .NET SDK | matching `server/Koc.Vessels.Api/*.csproj` |
| Node | 20+, for building `web/` |
| `keys.env` | at the repo root, untracked. See `database/README.md`. |

## First run, locally

```bash
./database/migrate.sh          # applies 000..004 in order, journalled
cd web && npm ci && npm run build
```

`migrate.sh --status` shows what has been applied without changing anything.

## Deployment — NOT YET DECIDED

**This section is deliberately unfinished.** The target environment has not been
confirmed, and guessing it would produce config that looks authoritative and is
wrong. What is known:

- KOC runs **SQL Server on Microsoft infrastructure**. That is the extent of it.
- The API is **ASP.NET Core**, which is the right choice for that world whether it
  ends up on IIS, on Windows Service / Kestrel behind a reverse proxy, or in a
  container. Nothing below the API layer needs to change when this is settled.
- `web/` builds to static files (`web/dist`) and can be served by the API, by IIS,
  or from a share. It has no server-side runtime.

**To fill in when you know:**

- [ ] SQL Server instance name, authentication mode, and who owns the `DWO` database
- [ ] Where the connection string lives (IIS app settings? environment? a vault?)
- [ ] How migrations run in that environment — `migrate.sh` is a local Docker
      convenience. `dbo.SchemaVersions` is deliberately DbUp's default shape, so
      the API can take over migrations and pick up from the same journal.
- [ ] Web host and base path
- [ ] Whether outbound internet exists on the build agent — this decides the
      design-system question below

The previous repo carried `vercel.json` and `docker-compose.yml`. Both were for a
demo deployment and neither came across. Do not resurrect them as a template.

## The design system dependency

`web/` consumes `@koc/*` from a **private** GitHub repo
(`SaudKWT/koc-design-system`) via the GitHub Contents API, pinned to `v0.1.1` in
`web/components.json`.

**This does not affect building or deploying.** `shadcn add` is a one-shot,
build-time operation: component source is copied into `web/src/components/ui/`
and committed. Everything needed to compile is already in this repo. You can
build with no network access to GitHub at all.

It matters only when you want to add a component that isn't installed yet. Two
options, and this is a decision for Saud:

1. **A collaborator token.** You get read access to the design-system repo and
   your own fine-grained token in `KOC_REGISTRY_TOKEN`. Needs `api.github.com`
   reachable from wherever you run the CLI.
2. **Vendor the registry.** Copy the registry JSON into
   `vendor/koc-registry/` and point `components.json` at the local path. No
   network, no token, at the cost of a manual refresh when the system updates.

If KOC build agents can't reach GitHub, take option 2.

Two things the CLI cannot do for you after `npx shadcn add @koc/theme`, both
silent if missed — see `docs/CONSUMING.md` in the design system:

- `@import "tw-animate-css";` must be the **second line** of `web/src/styles.css`
- Inter must be loaded in `web/index.html`

## Adding a module

The vessel app is the worked example. Follow it, plus the step it skipped.

1. **Tables.** Additive script `database/00N-<name>.sql`. Never `ALTER` or `DROP`
   anything from `001-schema0726.sql` — that file is the corporate schema, kept
   byte-for-byte as delivered, and may be shared with other KOC systems. Copy
   `002-marine-tables.sql`'s conventions: `[ID] int IDENTITY` + `PK_<Table>`,
   parent-prefixed child tables, unique indexes on natural keys, soft-delete
   flags on master tables only, Kuwait local time with a `Utc` suffix marking the
   exception, and existence guards on every object.

2. **Register it.** `004-register-modules.sql` shows the four inserts:
   `Privilege` → `Module` → `Form` per screen → `Status` vocabulary.

   **Do not skip this.** `dbo.Log` declares `[ModuleID] int NOT NULL`, so a module
   with no registry row cannot write a single audit entry. The vessel app shipped
   in exactly that state and `004` is the fix.

3. **API.** A controller and EF entities in `server/`. One service — do not stand
   up a second API.

4. **Web.** A folder under `web/src/features/`, and an entry in the unit's nav in
   `web/src/config/dwos.ts`. No component is edited to add a module.

5. **Grants.** `RolePrivilege` / `UserPrivilege` are left empty by the migrations
   on purpose. Who may see a module is a KOC access decision, not a schema change.

## Known gaps

Honest list. None of these are hidden in the code.

- **The web app reads bundled JSON fixtures, not the API.** `web/src/features/
  vessel-movement/data/` is a snapshot of the real corpus for development. Wiring
  it to `server/` is the next substantial piece of work.
- **The seven unit bindings are unresolved.** `web/src/config/schema-binding.ts`
  has `entityCode: null, teamId: null` for all seven. They were not guessed —
  a wrong `TeamID` silently scopes a screen to the wrong unit's data. They need
  to come from `dbo.Entity` in the live database.
- **The DWOS nav beyond Offshore is placeholder.** The org structure is real; the
  workflow lists under each unit are plausible inventions. Replace before showing
  a KOC team.
- **`dbo.Privilege`, `Role`, `RolePrivilege`, `UserPrivilege` and `UserRole` have
  no primary key, no unique constraint and no index** — the only five tables of
  43 in that state, and the ones every module hits on every request. Worth fixing
  before module #3, in its own migration.
- **No screen reader has been run.** Behaviour is tested in Chromium. KOC is a
  Windows/Edge organisation, so test NVDA + Edge.
