# The build → deploy → feedback loop

How work moves between Saud (design, domain knowledge, decisions), the Claude
sessions building this repo, and the KOC developer who deploys it. Written to be
tested on a pilot, then followed for every module after.

## Roles, honestly stated

| who | owns | does not do |
|---|---|---|
| **Saud** | what gets built, real KOC knowledge (org, workflows, forms), approvals, relaying feedback | deploy, write code |
| **Claude** | implementation, the gates, docs kept current in the same commit | invent KOC workflows, guess environment facts |
| **KOC dev** | deployment, environment truth, review of what he deploys | fight the tooling — anything he must change locally is a bug here |

That last cell is the load-bearing rule, learned this session between the design
system and this app: **the deployer's environment is the next consumer side.**
Seven distribution defects were found by consumer reports that were invisible
from inside the producing repo. His server is to this repo what this repo was to
the design system — so his feedback comes back the same way, as a written report
against a named release.

## The loop

1. **Build.** Feature lands with every gate green: `tsc`, build, motion,
   round-trip parity, a11y suite, and for backend work `dotnet build` + the
   published-artifact smoke.
2. **Document in the same commit.** Anything that changes how he installs,
   migrates, or deploys goes into `HANDOFF.md` with the change, not after it.
3. **Tag.** `git tag vX.Y.Z && git push origin vX.Y.Z`. What he deploys is
   always a tag name, never "latest main" — main routinely carries work between
   releases.
4. **Hand over.** He gets: collaborator access to this repo, the tag name, and
   one sentence on what changed. His entry point is `HANDOFF.md`; his build is
   `./publish.sh` (or its three Windows-equivalent steps, documented there);
   his check is `./smoke.sh <url>`.
5. **He deploys and files a report.** Copy
   `docs/deployment-reports/TEMPLATE.md` to `YYYY-MM-DD-<tag>.md`, fill it in —
   Saud can transcribe if the dev prefers talking to writing. Raw notes are
   fine; structure matters less than the facts.
6. **The report drives the next iteration.** Every friction item becomes a fix
   here; every environment fact retires a TBD in `HANDOFF.md`'s deployment
   section; every local change he made gets absorbed into the repo so the next
   deploy needs none.

## The pilot

Two steps, deliberately small:

**Step 0 — deploy what exists.** The vessel module, as tagged. No new code.
This tests the mechanics: access, publish, database scripts against a real KOC
SQL Server, smoke, the report coming back. Success = `SMOKE OK` on a KOC server
and a filed report.

**Step 1 — one real short form, through the whole loop.** Chosen by Saud and
the dev together, and it must be a *real* DWOS form — a thing that exists today
on paper or in Excel. Not invented: every workflow in this repo's nav beyond
Offshore is a placeholder, and building the pilot on a placeholder would test
nothing about real requirements. Step 1 exercises the full recipe in
`HANDOFF.md` § Adding a module: numbered SQL script + module registration,
`Modules/<Name>/` controller, web feature folder, nav entry, gates, tag,
deploy, report.

Success for the pilot overall: one full circuit of the loop with at least one
friction item found, fixed here, and confirmed gone in the next deploy. A loop
that finds nothing was not tested hard enough to trust.

## Versioning

This repo's tags are independent of the design system's. The design system
versions the *look* (`web/vendor/koc-registry/VERSION` records which); this
repo's tags version the *platform*. A deployment report names the platform tag;
if a design-system sync landed since the last tag, the report inherits it
automatically.

## Where things land

```
docs/HANDOFF.md              how to run and deploy — the dev's entry point
docs/WORKFLOW.md             this file — how work moves between people
docs/deployment-reports/     his feedback, one file per deploy, template inside
docs/api/openapi.json        the API contract at this commit, reviewable as a diff
publish.sh · smoke.sh        build the artifact · check any instance
```
