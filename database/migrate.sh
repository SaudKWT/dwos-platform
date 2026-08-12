#!/usr/bin/env bash
# Applies the SQL scripts in this folder, in filename order, to the local
# SQL Server container.
#
#   ./database/migrate.sh            apply pending scripts
#   ./database/migrate.sh --status   show what has been applied, change nothing
#
# Each applied script is recorded in dbo.SchemaVersions and never run twice.
# That table's shape is DbUp's default, so when the API takes over migrations
# it reads the same journal and picks up exactly where this script left off.
#
# Why a journal rather than "make every script re-runnable":
#   001-schema0726.sql is the corporate script, kept byte-for-byte as delivered.
#   It is full of bare CREATE TABLEs and fails on a second run. Rewriting it to
#   be idempotent would mean it no longer matches the file the DBA gave us, and
#   comparing them later would be guesswork.
#
# Credentials come from keys.env at the project root (untracked). The scripts
# run through the sqlcmd inside the container, so no SQL tooling is needed on
# the Mac.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${MSSQL_CONTAINER:-vessels-sql}"
STATUS_ONLY=0
[[ "${1:-}" == "--status" ]] && STATUS_ONLY=1

if [[ ! -f "$ROOT/keys.env" ]]; then
  echo "error: $ROOT/keys.env not found. See database/README.md." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source "$ROOT/keys.env"; set +a

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "error: container '$CONTAINER' is not running. Start it with:" >&2
  echo "  docker compose --env-file keys.env up -d" >&2
  exit 1
fi

sqlcmd() { docker exec -i "$CONTAINER" /opt/mssql-tools18/bin/sqlcmd \
             -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -b "$@"; }

# 000 creates the database the journal itself lives in, so it always runs and is
# self-guarding rather than journalled.
echo "==> 000-create-database.sql"
sqlcmd -i /dev/stdin < "$ROOT/database/000-create-database.sql"

sqlcmd -d DWO -Q "
IF OBJECT_ID(N'[dbo].[SchemaVersions]', N'U') IS NULL
CREATE TABLE [dbo].[SchemaVersions](
    [SchemaVersionsID] [int] IDENTITY(1,1) NOT NULL CONSTRAINT [PK_SchemaVersions_ID] PRIMARY KEY,
    [ScriptName] [nvarchar](255) NOT NULL,
    [Applied] [datetime] NOT NULL);
" >/dev/null

applied() { sqlcmd -d DWO -h -1 -W -Q \
  "SET NOCOUNT ON; SELECT ScriptName FROM dbo.SchemaVersions ORDER BY SchemaVersionsID;" \
  | grep -v '^$' || true; }

if [[ $STATUS_ONLY -eq 1 ]]; then
  echo; echo "Applied scripts:"; applied | sed 's/^/  /'
  echo; echo "Pending scripts:"
  for script in "$ROOT"/database/[0-9][0-9][0-9]-*.sql; do
    name="$(basename "$script")"
    [[ "$name" == 000-* ]] && continue
    applied | grep -qxF "$name" || echo "  $name"
  done
  exit 0
fi

APPLIED_LIST="$(applied)"
ran=0
for script in "$ROOT"/database/[0-9][0-9][0-9]-*.sql; do
  name="$(basename "$script")"
  [[ "$name" == 000-* ]] && continue
  if grep -qxF "$name" <<<"$APPLIED_LIST"; then
    echo "==> $name (already applied, skipping)"
    continue
  fi
  echo "==> $name"
  # -b makes sqlcmd exit non-zero on a SQL error, so set -e catches it and the
  # script is NOT journalled — a failed migration stays pending.
  sqlcmd -d DWO -i /dev/stdin < "$script"
  sqlcmd -d DWO -Q "INSERT INTO dbo.SchemaVersions (ScriptName, Applied) VALUES (N'$name', GETDATE());" >/dev/null
  ran=$((ran + 1))
done

[[ $ran -eq 0 ]] && echo "Nothing to do - database is up to date."

echo
echo "==> Verifying"

# This block used to name the twelve marine tables literally, so it reported
# "Migration OK" without checking a single table belonging to any module added
# after the vessel app. The checks below are the ones that stay true as modules
# are added: every script in the directory is recorded as applied, and every
# module in the registry is complete enough to be usable.
#
# The Module check is not bookkeeping. dbo.Log declares [ModuleID] int NOT NULL,
# so a module with no registry row cannot write an audit entry at all — which is
# exactly the state the vessel app shipped in before 004.
# 000 creates the database itself and is never recorded in SchemaVersions.
expected_scripts=$(ls "$ROOT"/database/[0-9][0-9][0-9]-*.sql | grep -vc '/000-')

sqlcmd -d DWO -h -1 -W -Q "
SET NOCOUNT ON;
SELECT CONCAT('tables total    : ', (SELECT COUNT(*) FROM sys.tables));
SELECT CONCAT('foreign keys    : ', (SELECT COUNT(*) FROM sys.foreign_keys));
SELECT CONCAT('scripts applied : ', (SELECT COUNT(*) FROM dbo.SchemaVersions), ' / $expected_scripts');
SELECT CONCAT('modules         : ', (SELECT COUNT(*) FROM dbo.Module WHERE IsActive = 1));

IF (SELECT COUNT(*) FROM dbo.SchemaVersions) <> $expected_scripts
  RAISERROR('applied script count does not match the files in database/', 16, 1);

-- A module with no forms is a menu entry that goes nowhere.
IF EXISTS (SELECT 1 FROM dbo.Module m
           WHERE m.IsActive = 1 AND m.IsAttachedToMenu = 1
             AND NOT EXISTS (SELECT 1 FROM dbo.Form f WHERE f.ModuleID = m.ID))
  RAISERROR('a menu-attached module has no forms', 16, 1);

-- A module whose menu node points at no privilege is ungated.
IF EXISTS (SELECT 1 FROM dbo.Module WHERE IsActive = 1 AND PrivilegeID IS NULL)
  RAISERROR('an active module has no gating privilege', 16, 1);
"
echo "==> Migration OK"
