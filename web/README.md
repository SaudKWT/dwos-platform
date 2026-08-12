# DWOS team dashboard

The Drilling & Workover Operational Support Team's dashboard, built on the
[KOC Design System](https://github.com/SaudKWT/koc-design-system) via the `@koc`
shadcn registry.

```bash
npm install
npm run dev      # http://localhost:4200
npm run build    # tsc -b && vite build
```

## What is here

| | |
| --- | --- |
| **The dashboard** | `src/config/dwos.ts` — 7 units plus the team-wide zone. The whole shell is configured from this one object; adding a unit or an app is an edit here, never a component. |
| **The one real app** | Vessel Movement, under Unit 4 · Offshore: fleet map with AIS playback, 256 daily reports, the captain's report form, the 48-hour movement plan. |
| **Everything else** | Configured, not built. Those routes land on a page that says so and names the schema table they will read. |

## Consuming the design system

Setup follows `docs/CONSUMING.md` in the design system repo. `components.json`
pins the registry to a tag:

```
https://api.github.com/repos/SaudKWT/koc-design-system/contents/apps/docs/public/r/{name}.json?ref=v0.1.0
```

It needs `KOC_REGISTRY_TOKEN` in the environment — a fine-grained PAT scoped to
that one repo, Contents → Read-only. Never commit it.

Install the theme **first**; every component assumes its variables exist.

```bash
npx shadcn@latest add @koc/theme
npx shadcn@latest add @koc/app-shell @koc/data-table
```

**After any `shadcn add`, check two things.** Both exist because they have gone
wrong before, silently:

```bash
git diff src/styles.css      # a stock :root/.dark block appended below the KOC tokens wins over them
git status                   # third-party registry items can write outside your configured aliases
```

## The rules this app follows

- **No hand-written hex.** Semantic tokens only. Three deliberate exceptions,
  each documented at the point of use: `simulator/icons.ts` (marker artwork —
  illustration, not theme), `report-form/buildReportHtml.ts` (a facsimile of the
  official paper form, printed on white paper), and `Vessel.MapColor` (a column
  in `dbo.Vessel` — data that happens to be a colour). Leaflet paths that *are*
  theme read the tokens at paint time via `simulator/mapTokens.ts`.
- **Motion from the scale.** `duration-fast|base|slow|slower`, `ease-out|in|spring`.
  Never `duration-200`, never an arbitrary value.
- **Charts keep `isAnimationActive={false}`.** Hardcoded inside `@koc/chart`;
  under React 19 StrictMode Recharts otherwise draws nothing at all.
- **`--input` is not `--border`.** An input's boundary is the only cue the
  control exists and must clear 3:1.

## Data

`src/features/vessel-movement/data/` is a point-in-time export of the marine
tables in `schema0726` — 5 vessels, 256 daily reports, 9 movement plans, 20 AIS
day-tracks. `api/client.ts` serves it behind the same interface the live API
exposes, so swapping to SQL Server is replacing those function bodies.

Submissions are held in memory for the session; the form says so.

## Schema binding

`src/config/schema-binding.ts` joins the nav config to the database:
`dbo.Entity` (`EntityCode`, `ParentEntityID`) holds Directorate → Group → Team →
Unit, and `TeamID` on `dbo.RigInfo` / `dbo.Workover` is what scopes work to a
unit. The IDs are `null` until someone reads them off the live database —
a wrong `TeamID` does not error, it silently returns another unit's rigs.
