#!/usr/bin/env bash
# Post-deploy smoke check. Run against any instance, local or KOC:
#
#   ./smoke.sh                          # default http://127.0.0.1:5280
#   ./smoke.sh http://dwos-server:80
#
# Read-only — it GETs, never posts. Exit code 0 means every check passed.
# Paste the output into the deployment report (docs/deployment-reports/).
#
# Against a DEV api (`dotnet run`, :5280) the last three checks fail by design:
# in development Vite serves the SPA on :4200, not the API. The full ten only
# pass against a published artifact — which is the thing being smoke-tested.
set -u
BASE="${1:-http://127.0.0.1:5280}"
fail=0
check () { # path, grep-pattern, label
  body=$(curl -sf -m 10 "$BASE$1" 2>/dev/null); code=$?
  if [ $code -ne 0 ]; then printf "  FAIL %-28s (no response)\n" "$1"; fail=1; return; fi
  if echo "$body" | grep -q "$2"; then printf "  ok   %-28s %s\n" "$1" "$3"
  else printf "  FAIL %-28s (unexpected body)\n" "$1"; fail=1; fi
}
echo "smoke: $BASE"
check /api/health        '"ok":true'        "$(curl -s "$BASE/api/health")"
check /api/vessels       '"vessels"'        "fleet"
check /api/reports       '"reports"'        "report index"
check /api/movement-plans '"plans"'         "plan index"
check /api/modules       '"Vessel Movement"' "module registry readable"
check /api/platform      '"org_seeded"'     "$(curl -s "$BASE/api/platform")"
# /api/me is AllowAnonymous and reports auth state as JSON in every mode —
# paste its body into the deployment report so the auth mode is on record.
check /api/me            '"auth_mode"'      "$(curl -s "$BASE/api/me")"
check /                  'id="root"'        "SPA root"
check /unit-4/vessels/reports 'id="root"'   "deep link falls back to SPA"
check /fonts/inter.css   'Inter'            "self-hosted fonts"
[ $fail -eq 0 ] && echo "SMOKE OK" || echo "SMOKE FAILED"
exit $fail
