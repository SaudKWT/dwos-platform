# DWOS Platform — handoff

For the in-house KOC developer taking this to KOC servers. How work moves
between people — build, tag, deploy, feedback — is `WORKFLOW.md` beside this
file; your feedback goes in `deployment-reports/`, template included.

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
| .NET SDK | **9.0** — `server/*.csproj` target `net9.0`. On macOS: `brew install dotnet@9` (keg-only; export `DOTNET_ROOT` and add its `bin` to `PATH`) |
| Node | 20+, for building `web/` |
| `keys.env` | at the repo root, untracked. See `database/README.md`. |

## First run, locally

```bash
cp keys.env.example keys.env && $EDITOR keys.env   # password + connection string
docker compose --env-file keys.env up -d           # local SQL Server, container dwos-sql
./database/migrate.sh                              # applies 000..004, journalled

set -a; . ./keys.env; set +a                       # API and importer read ConnectionStrings__Dwo
dotnet run --project server/Koc.Dwos.Importer -- --data reference/data
dotnet run --project server/Koc.Dwos.Api --launch-profile http   # :5280

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

## Building the deployable

```bash
./publish.sh            # → ./publish — the entire deployment in one folder
```

It builds `web/`, copies `web/dist` into the API's `wwwroot`, and runs
`dotnet publish -c Release`. The output serves the API, the SPA, deep links and
self-hosted fonts with **no internet access at runtime**. On Windows it is the
same three steps by hand: `npm run build` in `web\`, copy `web\dist\*` into
`server\Koc.Dwos.Api\wwwroot\`, `dotnet publish -c Release`.

Run it with config from the environment — published apps read no launchSettings:

```bash
ConnectionStrings__Dwo='Server=...;Database=DWO;...' \
ASPNETCORE_URLS=http://0.0.0.0:5280 \
dotnet publish/Koc.Dwos.Api.dll
```

Content root is pinned to the binary's folder in code, so the working directory
does not matter — found the hard way: run from anywhere else, the API answered
and the entire SPA 404'd, silently. IIS sets content root itself; consoles and
services do not.

Then, against any instance:

```bash
./smoke.sh http://server:5280     # ten read-only checks; paste into the report
```

The three SPA checks fail by design against a *dev* API (`dotnet run`), where
Vite serves the frontend. All ten pass only against a published artifact —
which is the thing being smoke-tested.

The API surface at this commit is `docs/api/openapi.json`, committed so a
release's contract reviews as a diff.

### Loading the data without the importer

The importer needs .NET and a connection from this repo's side, which a KOC
cluster does not offer. So the data ships as one plain T-SQL file:

```
database/seed-marine-data.sql      # ~4 MB, generated — run with sqlcmd or SSMS
```

It clears the marine tables and reloads them (identities preserved, so every
foreign key matches), touches nothing from `001-schema0726.sql`, and is
re-runnable. Apply the schema scripts first, then:

```
sqlcmd -S <server> -d DWO -E -i seed-marine-data.sql
```

It is **generated, never edited**: the importer writes it from a database whose
contents just passed the full verification (row counts, coordinate values,
vessel particulars), and the generation is itself gated on that verification.
To regenerate after the JSON corpus changes:

```bash
dotnet run --project server/Koc.Dwos.Importer -- --data reference/data \
  --emit-seed database/seed-marine-data.sql
```

The round trip is provable locally: apply the generated script with `sqlcmd`,
then `dotnet run --project server/Koc.Dwos.Importer -- --data reference/data
--verify-only` — the same checks that gate the import gate the script.

Two things the connection string carries locally that yours should not:
`TrustServerCertificate=True` exists for the local container's self-signed
certificate — drop it where real certificates exist. And `sa` is the local dev
login; the app needs only read/write on the marine tables plus read on the
corporate ones.

## Authentication — Windows/AD

Per your answer (2026-08-16): Windows login is the identity. Implemented with
Negotiate, behind one environment variable:

| `Auth__Mode` | behaviour |
|---|---|
| `Windows` | **production.** Every endpoint requires an authenticated user. Exceptions: `/api/health` (monitoring) and `/api/me` (reports auth state as JSON). |
| `Disabled` | local-dev default (macOS has no AD). Logged loudly at startup so it cannot be mistaken for a production state. |

Under IIS, enable **Windows Authentication** on the site and the identity
arrives from IIS; self-hosted, the Negotiate handler does Kerberos/NTLM itself.

`GET /api/me` turns the Windows identity into the corporate user: it matches
`DOMAIN\user` against `dbo.[User].Username` (with or without the domain), and
resolves privileges as the union of direct grants (`UserPrivilege`) and
role-carried ones (`UserRole` → `RolePrivilege`), date-windowed. These are the
same PrivilegeIDs `dbo.Module` and `dbo.Form` point at, so the client can gate
modules from this one call. The credential columns on `dbo.[User]` are
**not mapped at all** — under Windows auth the app never touches a password,
and an entity that cannot select a credential column cannot leak one.

Verified on 2026-08-16 as far as a non-domain machine allows: `Windows` mode
401s everything with a correct `WWW-Authenticate: Negotiate` challenge, health
stays 200, `/api/me` reports state. **The actual AD handshake has never run —
your step-0 deployment verifies it. Open the app, then check `/api/me` shows
your account.**

## Deployment — the answers so far (2026-08-16)

**This section is deliberately unfinished.** The target environment has not been
confirmed, and guessing it would produce config that looks authoritative and is
wrong. What is known:

- KOC runs **SQL Server on Microsoft infrastructure**. That is the extent of it.
- The API is **ASP.NET Core**, which is the right choice for that world whether it
  ends up on IIS, on Windows Service / Kestrel behind a reverse proxy, or in a
  container. Nothing below the API layer needs to change when this is settled.
- `web/` builds to static files (`web/dist`) and can be served by the API, by IIS,
  or from a share. It has no server-side runtime.

The developer answered on 2026-08-16. Recorded verbatim-in-spirit, with what
each answer changed:

- [x] **Auth: Windows/AD.** Built — see § Authentication above.
- [x] **.NET 8 confirmed fine.** ~~Target stays `net8.0`.~~ **Superseded 2026-08-26:**
      the server runs **.NET 9.0.7**, so everything is retargeted to `net9.0`
      (all four `server/*.csproj`, packages on 9.0.x). The publish artifact is
      framework-dependent; a 9.0.x patch difference between build SDK and server
      runtime rolls forward automatically.
- [~] **WebSockets: "assumed enabled."** Recorded as an assumption, not a fact —
      the deployment report asks you to confirm the live map holds a WebSocket
      connection rather than silently long-polling.
- [ ] **SQL Server version / DWO ownership / how migrations run: answer coming.**
      Still the biggest open item for step 0.
- [x] **Org data: you control the database.** Understood — `GET /api/platform`
      after deploy tells both of us whether `dbo.Entity` is populated;
      `org_seeded` non-zero is what unlocks the dashboard's unit bindings.
- [x] **Connection string: environment variable.** Exactly how it is built —
      `ConnectionStrings__Dwo`, nothing to change.
- [~] **NuGet/npm reachability: unknown.** The `publish.sh` output needs
      neither, so the artifact handover path is the safe default until known.
- [x] **Naming: read as "name by the solution"** — everything is now
      `Koc.Dwos.*` (was `Koc.Vessels.*`, the platform named after module #2).
      If a different convention was meant, say so now while the rename is one
      commit deep.

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
npm run koc:sync -- v0.1.4 --from "/path/to/KOC Design System"
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

**Re-add the importers too.** Registry dependencies point one way (`command`
declares `@koc/dialog`); breakage flows the other way. When a component you
re-add has changed its types, every installed component that imports it can
stop compiling until it is also re-added — first seen 2026-08-16, when the
Base UI dialog port broke the vendored `command.tsx` here (`tsc` failed in a
file nobody asked to change) until `@koc/command` was re-added. Find the
importers of an item with:

```bash
grep -l '"@koc/dialog"' vendor/koc-registry/*.json
```

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

### Confirming an update actually landed

Done twice by hand now, so it is written down. A design-system release is not
"taken" when the files change — it is taken when the change is visible in the
running app, and the two are not the same event.

**1. Read the payload before you sync.** In the design system:

```bash
npm run release:status <the tag you are on>
```

It separates the two kinds, and your action differs for each:

| | what it means | what you do |
|---|---|---|
| a changed **cssVar** | restyles the app, including components you never re-add | re-add `@koc/theme` |
| a changed **component file** | does nothing at all until that component is re-added | re-add that component |

A `+` line is usually harmless. A `+` line **flagged as overriding a Tailwind
default is not** — it re-points a class already used everywhere. That flag exists
because `--text-sm` was new to the payload and not new to Tailwind, and shifted
every table cell in this app on upgrade.

**2. Sync from the tag, never from `main`.** `koc:sync` reads through
`git show <tag>:` for this reason. `main` routinely carries committed but
unreleased work — at v0.1.3 it held nine variable changes belonging to the *next*
release. Syncing from a branch will pull them in and nothing will tell you.

**3. Verify in the browser, as computed styles.** Screenshots do not distinguish
`--secondary` from `--accent` when they hold the same value. For a change that
alters a state — hover, selected, focus, disabled — read **all** of the states,
not just the one that changed:

```js
// in the browser console, on the affected screen
const el = document.querySelector('[data-slot="sidebar-menu-button"][data-active="true"]')
getComputedStyle(el).backgroundColor
```

Hover cannot be forced from a script — move a real pointer, then read.

**Why all the states and not just the changed one:** v0.1.4 moved `--accent` onto
the same value as `--secondary` and `--muted`. Nothing about the sidebar looked
wrong. What broke was a form control elsewhere whose *selected* half used one
token and whose *hover* used the other — they had been different colours and were
now identical, so hovering an unselected option made it look chosen. The changed
token was fine. The pair was not.

**4. Run the suites.** `npm run test:a11y` in `web/`, plus the design system's
motion gate above. Neither is optional after a component re-add: twelve
components once sat a version behind for a day, carrying bugs already fixed
upstream, and nothing failed.

### The daily loop, once everything exists

First-run is above. Day to day it is:

```bash
docker compose --env-file keys.env up -d          # if not already running
set -a; . ./keys.env; set +a
dotnet run --project server/Koc.Dwos.Api --launch-profile http &
cd web && npm run dev
```

The importer only needs re-running when the JSON corpus in `reference/data/`
changes. `migrate.sh` only when a new script lands in `database/`. Both are
safe to re-run at any time and say so when there is nothing to do.

### Two things that are silent when wrong

Both are already correct in this repo. They matter if you ever rebuild the CSS
entry from scratch — see `docs/CONSUMING.md` in the design system:

- `@import "tw-animate-css";` must be the **second line** of `web/src/styles.css`.
  Below that and every entrance animation is inert: tooltips, dropdowns, dialogs
  and sheets pop instead of animating, with nothing in the build to say why.
- Inter must be loaded in `web/index.html`. It is **self-hosted** at
  `web/public/fonts/` — it was an rsms.me link, which on an intranet fails
  silently into the system font stack. If the CSS entry is ever rebuilt, keep
  the `/fonts/inter.css` link, not a CDN.

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

3. **API.** A folder under `server/Koc.Dwos.Api/Modules/`, one service — do
   not stand up a second API. The layout is:

   ```
   Modules/
     Marine/      the vessel module: 5 controllers, ReportWriter, LiveHub
     Platform/    not a module — the registry and org endpoints every module needs
     <yours>/     controllers + services for module #3
   ```

   Entities go in `Koc.Dwos.Domain`, split the same way: `MarineEntities.cs`
   for tables this platform owns and writes, `PlatformEntities.cs` for the
   read-only slice of the corporate schema.

   **Corporate tables are read-only and that is enforced, not remembered.**
   Everything from `001-schema0726.sql` is mapped with
   `.ToTable(..., t => t.ExcludeFromMigrations())` and read with `AsNoTracking`,
   so a stray `SaveChanges` cannot carry a change into a table the DBA owns. Only
   what is needed is mapped — six types out of forty-three — because scaffolding
   the rest would create thirty-seven ways to write to one of them.

   There are no EF migrations at all, deliberately: `dotnet ef migrations add`
   against a scaffolded legacy schema will happily generate a script that drops
   somebody else's tables. Schema changes ship as numbered SQL.

   **Platform endpoints already built**, so a new module does not reinvent them:

   | | |
   |---|---|
   | `GET /api/modules` | the registry `004` writes — modules and their forms, in menu order |
   | `GET /api/org/entities?type=Unit` | the org hierarchy; the rows whose Id is `RigInfo.TeamID` |
   | `GET /api/platform` | counts, including `org_seeded` |

   `org_seeded` is the honest one. A fresh DWO has an **empty `dbo.Entity`** —
   `001` ships DDL and no rows — so unit scoping cannot be resolved locally at
   all. A client reads that count and says "not scoped to this unit yet" rather
   than quietly showing the whole directorate. Never hardcode an Entity Id:
   `001` declares no unique constraint anywhere, every table keys on
   `int IDENTITY`, so ids differ between any two DWO databases. Resolve by
   `EntityCode` at runtime.

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

Last updated: 2026-08-30. Design system pinned at v0.2.0 (Base UI). Backend on
.NET 9 (server runs 9.0.7 — his 2026-08-26 report). `database/seed-marine-data.sql`
added for DBA-side loading, round-trip verified locally via sqlcmd + `--verify-only`.
Windows/AD auth built (AD handshake pending step-0 verification).
