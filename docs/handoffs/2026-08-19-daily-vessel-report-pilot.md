# Handoff: daily vessel report form — workflow pilot

**Branch:** `pilot/daily-vessel-report` · **From:** Saud · **To:** the KOC
developer · **Scope:** one module, deliberately small.

This is the handoff we agreed to pilot: Saud develops a workflow/component,
you review and deploy it, and both of us note where the process creaks. The
code change is real but intentionally minor — the thing under test is this
document and the steps around it. If a section below didn't tell you what
you needed, that's a finding; write it in § Feedback.

## What changed, and why

One file: `web/src/features/vessel-movement/report-form/ReportForm.tsx`.

The form's three **action-level** buttons (Submit report, Print / PDF, the
warnings toggle) were hand-rolled `<button>`s predating the design system's
Button. The submit button had `hover:opacity-90` — not the system's hover —
and no focus-visible treatment of its own; only the theme's base-layer
outline kept keyboard focus visible on the most important control on the
page. All three are now `@koc/button` (default, outline, and outline with
the warning tint kept via className). The form's **dense row controls stay
native** — that's the documented density decision in `report-form/ui.tsx`,
not an oversight.

## Before you review: the branch ancestry

Local `main` here is 7 commits ahead of `origin/main` — those are the Base
UI migration takes (registry `v0.2.0`). This branch is cut on top of them,
so a PR against `origin/main` will show all of that, not one module.
**Ask Saud to push `main` first** (his call — main may be deploy-adjacent
on your side), then the PR diff collapses to this one file plus this
document.

## Run it

```bash
# once: the SQL container and keys
docker start dwos-sql
# API (terminal 1, from the repo root)
set -a; . ./keys.env; set +a; dotnet run --project server/Koc.Dwos.Api --launch-profile http
# web (terminal 2)
cd web && npm install && npm run dev   # → http://localhost:4200
```

Open **File a report** from the sidebar and scroll to the bottom action bar.

## Verify

All of these were green when handed off; re-run them yourself — that's the
point of the pilot:

```bash
cd web
npx tsc -b          # types
npm run build       # production build
npm run test:parity # 255 imported reports round-trip through this form exactly
npx playwright test # 9 tests incl. the form's required-fields and warning-focus behaviour
```

Manual, two minutes: Tab to **Submit report** — a visible 2px brand-blue
ring (that ring is the system's focus contract). Hover it — the background
deepens rather than the whole button fading. The warnings pill (make a task
row overlap to get one) still reads amber and toggles the list, and each
warning still focuses its field.

## Deploy

Nothing outside `web/src` changed: no dependency, schema, config or API
change. Your normal web build/deploy path applies as-is.

## Feedback — the actual deliverable of this pilot

For each, a sentence is enough; we fold the answers into the next handoff's
template:

1. Could you review this without asking Saud anything? What was missing?
2. Was "run it / verify / deploy" the right structure? What order do you
   actually work in?
3. What should Saud's future branches include that this one didn't — tests,
   screenshots, a video, smaller diffs, bigger batches?
4. Where should these handoffs live so you see them — GitHub PRs, this
   docs folder, somewhere else?
