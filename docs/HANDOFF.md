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
npm run koc:sync -- v0.1.2 --from "/path/to/KOC Design System"
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
npm run koc:add -- @koc/dialog        # then read the diff
```

That overwrites the file, including local edits. This is the shadcn model, not a
vendoring limitation — installing from GitHub behaves identically.

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

Last updated: 2026-08-12.
