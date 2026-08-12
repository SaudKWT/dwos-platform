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
| .NET SDK | **8.0** — `server/*.csproj` target `net8.0`. On macOS: `brew install dotnet@8` (keg-only; export `DOTNET_ROOT` and add its `bin` to `PATH`) |
| Node | 20+, for building `web/` |
| `keys.env` | at the repo root, untracked. See `database/README.md`. |

## First run, locally

```bash
cp keys.env.example keys.env && $EDITOR keys.env   # password + connection string
docker compose --env-file keys.env up -d           # local SQL Server, container dwos-sql
./database/migrate.sh                              # applies 000..004, journalled

set -a; . ./keys.env; set +a                       # API and importer read ConnectionStrings__Dwo
dotnet run --project server/Koc.Vessels.Importer -- --data reference/data
dotnet run --project server/Koc.Vessels.Api --launch-profile http   # :5280

cd web && npm ci && npm run dev                    # :4200, proxies /api to 5280
```

The importer is re-runnable: it clears the marine tables and reloads from the
JSON corpus, then verifies row counts and coordinates against the source files.
It never touches a table from `001-schema0726.sql`.

`migrate.sh --status` shows what has been applied without changing anything.

Verified end to end on 2026-08-12 — Docker Desktop on arm64 under Rosetta, SQL
Server 2022, healthy in 20s, all five scripts clean: **56 tables, 30 foreign keys,
one registered module**. `004` is idempotent; re-running it inserts nothing.

The compose file is a laptop convenience, not a deployment artefact. KOC runs its
own SQL Server and nothing here describes it — see Deployment.

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

The previous repo carried a `vercel.json` for a demo deployment. It did not come
across; do not resurrect it as a template. `docker-compose.yml` did come across,
but it is a laptop SQL Server for development and says nothing about KOC.

## The design system

`web/` is built on the KOC Design System (`@koc/*`). **You need no GitHub access
and no token.** The registry is vendored into this repo at
`web/vendor/koc-registry/` — 42 items, version recorded in
`web/vendor/koc-registry/VERSION`.

Two separate things, often confused:

| | what it is | where it lives |
|---|---|---|
| The **registry** | the catalogue — one JSON per component | `web/vendor/koc-registry/` |
| The **components** | the actual source you compile | `web/src/components/ui/` |

The components are already installed and committed, so **building and deploying
touch neither the registry nor the network.**

### Adding a component

```bash
cd web
npm run koc:add -- @koc/dialog        # one or more items
```

That serves the vendored registry on `127.0.0.1:4183` for the length of the
command and runs the real shadcn CLI against it, so registry dependencies,
import rewriting and overwrite behaviour all work exactly as shadcn documents.
Nothing leaves the machine.

`npm run koc:serve` keeps it up if you'd rather run `npx shadcn add` yourself.

> Why not point shadcn straight at the folder? Because it can't. A relative
> registry path resolves against `https://ui.shadcn.com/r/`, and a `file://` URL
> returns *"not implemented... yet..."*. Both verified against the CLI on
> 2026-08-12. Loopback is the workaround, not a preference.

### Taking a design-system update

Run by whoever maintains the design system — it needs access to that repo:

```bash
cd web
npm run koc:sync -- v0.1.3 --from "/path/to/KOC Design System"
```

It reads the files at that **tag** (via `git show`, so an uncommitted experiment
can't leak in), replaces `vendor/koc-registry/` wholesale, and writes `VERSION`.
Commit the diff. You then receive it as an ordinary `git pull` or PR — a design
system change arrives as reviewable content in this repo, never as a silent fetch.

Without `--from` it falls back to the GitHub API and needs `KOC_REGISTRY_TOKEN`.

**Syncing does not update installed components.** Refreshing
`vendor/koc-registry/dialog.json` does not touch `src/components/ui/dialog.tsx`.
To take the update:

```bash
node scripts/koc-registry.mjs add @koc/dialog --yes --overwrite   # then read the diff
```

That overwrites the file, including local edits. This is the shadcn model, not a
vendoring limitation — installing from GitHub behaves identically.

**This is the easiest thing on this page to get wrong**, and it has already been
got wrong once here. After bumping to `v0.1.1` only `theme` was re-added, so
twelve components sat on the previous version for a day — carrying bare
transitions that the design system had already fixed. Nothing failed; they just
weren't the current components. After any sync, either re-add everything or be
deliberate about what you skipped.

To re-add the lot:

```bash
node scripts/koc-registry.mjs serve &     # one server
for i in $(ls src/components/ui/*.tsx | xargs -n1 basename | sed 's/.tsx//'); do
  npx shadcn@latest add "@koc/$i" --yes --overwrite
done
kill %1
```

Three quirks worth knowing, all found the hard way:

- **One item per invocation.** Passing 36 items to a single `shadcn add` joins
  them into one argument and 404s.
- **`--overwrite` is required** to refresh an existing file. Without it the CLI
  prompts, and in a script it just stops.
- **`npm run koc:add -- <args>`** joins its arguments. Call
  `node scripts/koc-registry.mjs add …` directly when passing more than one.

Then verify against the design system's own gate rather than by eye:

```bash
npx tsx <design-system>/packages/tokens/src/check-motion.ts web/src
```

### Two things that are silent when wrong

Both are already correct in this repo. They matter if you ever rebuild the CSS
entry from scratch — see `docs/CONSUMING.md` in the design system:

- `@import "tw-animate-css";` must be the **second line** of `web/src/styles.css`.
  Below that and every entrance animation is inert: tooltips, dropdowns, dialogs
  and sheets pop instead of animating, with nothing in the build to say why.
- Inter must be loaded in `web/index.html`. `--font-sans` names it first and
  falls through to the system stack without it, so the app renders in the wrong
  typeface and asks for contextual alternates that only exist in Inter.

### Rules that are load-bearing

These come from the design system and are commented as such where they appear.
Each exists because of a specific failure:

- Never hand-write a hex. Semantic tokens only — `--primary`, not a ramp step.
- Motion comes from the scale: `duration-fast|base|slow|slower`,
  `ease-out|in|spring`. Never `duration-200`, never a bare `transition-*` with no
  duration — Tailwind silently supplies 150ms, which is not a step here.
- `isAnimationActive={false}` stays on every chart line. Without it Recharts
  draws nothing at all under React 19 StrictMode. Still true in recharts 3.8.
- `--input` is a different token from `--border`, and must stay that way.
- After any `shadcn add`, check `git diff` on `web/src/styles.css` and
  `git status`. Third-party registry items append stock theme blocks and write
  outside your configured aliases.

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

- **`dbo.Entity` is empty**, so there is nothing yet to bind units to. `001` ships
  DDL only — no seed rows anywhere, including `Module`, `Entity` and `Status`. The
  seven unit bindings below therefore cannot be filled from a fresh local database;
  they need the real DWO instance.
- **The unit binding has no consumer yet.** Nothing calls `teamIdFor` or
  `unitScopeReady`, the API does not model `dbo.Entity`, and both `Entity` and
  `EntityType` are empty. Building the resolution path now would mean guessing
  the data and the shape of the need at once, so it is deliberately left alone
  until a screen actually needs to scope by unit.
- **The seven unit bindings are unresolved.** `web/src/config/schema-binding.ts`
  has `entityCode: null, teamId: null` for all seven. They were not guessed —
  a wrong `TeamID` silently scopes a screen to the wrong unit's data. They need
  to come from `dbo.Entity` in the live database.
- **The DWOS nav beyond Offshore is placeholder.** The org structure is real; the
  workflow lists under each unit are plausible inventions. Replace before showing
  a KOC team.
- **`dbo.Privilege`, `Role`, `RolePrivilege`, `UserPrivilege` and `UserRole` have
  no primary key, no unique constraint and no index** — the only five tables of
  43 in that state, and the ones every module hits on every request once
  authentication is on. A script is written and tested but **deliberately not
  applied**: `database/proposed/auth-table-keys.sql`. Those are `001` tables, and
  the rule here is that the corporate schema is read-only, so adding a clustered
  primary key is the DBA's call, not an unattended migration's. It sits outside
  `migrate.sh`'s glob and is journalled nowhere. Verified idempotent against a
  fresh DWO on 2026-08-12.
- **No screen reader has been run.** `cd web && npm run test:a11y` proves
  keyboard reach, visible focus, ARIA correctness and announced state across the
  five real screens (Playwright + axe, Chromium only — KOC is Windows/Edge and
  WebKit would be testing a browser no KOC user has). It cannot tell you what
  NVDA says: live-region politeness, table navigation mode, how `aria-sort` is
  voiced. **That pass is NVDA + Edge on Windows, by a person, and it has never
  been done.** Start with the report form — it is the only screen where someone
  types rather than reads.

  The suite needs the API up on 5280 with a seeded database; it will not silently
  pass against an empty one.

- **Two accessibility defects are upstream, in `@koc/*`,** and are scoped out of
  the suite rather than switched off — see the header of `web/tests/a11y.spec.ts`.
  `@koc/app-shell` renders its sidebar outside any landmark, and `@koc/alert`
  hardcodes `<h5>` for `AlertTitle`. Both reported 2026-08-12. Delete the scoping
  when the design system ships fixes.

---

## About this document

It is maintained as the system is built, not written at the end. If something
here is stale, that is a bug — report it.

Two conventions that keep it useful:

- **Unknowns are marked as unknowns.** The deployment section is a checklist of
  things to find out, not a guess. Config that looks authoritative and is wrong
  costs more than an admitted gap.
- **Known gaps are listed rather than hidden.** If a thing does not work yet, it
  is in the list above.

Last updated: 2026-08-12. Design system pinned at v0.1.3. Migrations, the full client→API→SQL Server round trip, and the a11y suite all verified locally.
