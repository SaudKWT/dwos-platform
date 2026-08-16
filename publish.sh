#!/usr/bin/env bash
# Builds the deployable artifact: the web app baked into the API, published once.
#
#   ./publish.sh [output-dir]        default: ./publish
#
# What it does, in order:
#   1. builds web/ (vite) — fails the whole publish if the frontend fails
#   2. copies web/dist into the API's wwwroot (generated, gitignored)
#   3. dotnet publish, Release
#
# The output directory is the whole deployment: one folder that serves the API,
# the SPA and its fonts, with no internet access needed at runtime. Run it with
# the connection string in the environment:
#
#   ConnectionStrings__Dwo='...' ASPNETCORE_URLS=http://0.0.0.0:5280 \
#     dotnet <out>/Koc.Dwos.Api.dll
#
# On Windows the equivalent is the same three steps: `npm run build` in web\,
# copy web\dist\* into server\Koc.Dwos.Api\wwwroot\, then
# `dotnet publish -c Release`. Nothing here is mac-specific except the paths.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# Program.cs serves wwwroot with a comment saying the client is "copied to
# wwwroot in production" — and until 2026-08-13 nothing anywhere performed that
# copy. `dotnet publish` produced an API whose SPA fallback pointed at a file
# that did not exist. The first person to notice would have been the KOC
# developer, on a KOC server, looking at a 404 and concluding the handoff was
# broken. The copy is a build step, so it lives in the build script.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$ROOT/publish}"
API="$ROOT/server/Koc.Dwos.Api"

# brew's dotnet@8 is keg-only; pick it up when dotnet is not already on PATH.
if ! command -v dotnet >/dev/null 2>&1 && [ -d /opt/homebrew/opt/dotnet@8 ]; then
  export PATH="/opt/homebrew/opt/dotnet@8/bin:$PATH"
  export DOTNET_ROOT="/opt/homebrew/opt/dotnet@8/libexec"
fi

echo "==> web build"
( cd "$ROOT/web"
  [ -d node_modules ] || npm ci
  npm run build )

echo "==> wwwroot"
rm -rf "$API/wwwroot"
mkdir -p "$API/wwwroot"
cp -R "$ROOT/web/dist/." "$API/wwwroot/"

echo "==> dotnet publish"
dotnet publish "$API" -c Release -o "$OUT" --nologo -v q

echo "==> done: $OUT"
echo "    $(ls "$OUT" | wc -l | tr -d ' ') files · wwwroot: $(ls "$OUT/wwwroot" | tr '\n' ' ')"
