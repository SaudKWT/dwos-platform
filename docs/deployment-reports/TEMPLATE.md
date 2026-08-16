# Deployment report — <tag>, <date>

Copy this file to `YYYY-MM-DD-<tag>.md` and fill in what you know. Raw notes
beat blank sections — anything is more useful than nothing, and Saud can
transcribe if writing this is a chore. Every "I had to change X locally" line
becomes a fix in the repo, so the next deploy needs no local changes.

## What was deployed

- Tag / commit:
- Onto (server, OS):
- By:
- Time it took, door to door:

## Environment facts

Each answer here retires a TBD in HANDOFF.md — this is how the deployment
section gets finished.

- SQL Server version, and who owns/created the `DWO` database:
- .NET runtime available on the server (`dotnet --list-runtimes`):
- Host model: IIS / Windows service / Kestrel behind a proxy / other:
- If IIS: are WebSockets enabled? (the live map hub is SignalR)
- Where the connection string lives in your world (IIS config / env var / appsettings / vault):
- Can the build machine reach nuget.org? npmjs? github.com?
- Auth expectation: Windows/AD (Negotiate) or app-level (JWT against `dbo.User`)?

## Did the docs hold?

For each step of HANDOFF.md you followed: did it work as written?
Name the step and what actually happened where it differed.

-

## Friction log

Anything that was slower, unclear, or surprising — even if you solved it.

-

## Local changes you had to make

Every entry here is a bug in the repo, not a note about your environment.
Describe or paste the diff.

-

## Smoke

Paste the output of `./smoke.sh <deployed-url>` (or note what you could not run):

```
```

## Platform counts

Paste the body of `GET <deployed-url>/api/platform`. If this DWO has real org
data, `org_seeded` / `units` being non-zero is the single most valuable fact you
can send back — it is what the dashboard's seven unit bindings are waiting for.

```
```

## Anything else

-
