#!/usr/bin/env bash
# Restore legacy SQL dump into tasdeeq_live (Docker Postgres).
# Usage:
#   DUMP_FILE=/path/to/dump-tasdeeq-202607241017.sql pm2 start ecosystem.config.cjs --only restore-dump
#   or: ./restoreDump.sh /path/to/dump-tasdeeq-202607241017.sql

set -euo pipefail

DUMP_FILE="${1:-${DUMP_FILE:-}}"
CONTAINER="${POSTGRES_CONTAINER:-tasdeeq-postgres-1}"
DB_USER="${POSTGRES_USER:-tasdeeq}"
DB_NAME="${POSTGRES_DB_LIVE:-tasdeeq_live}"

if [[ -z "$DUMP_FILE" ]]; then
  echo "ERROR: pass dump path as arg or set DUMP_FILE"
  echo "Example: DUMP_FILE=/root/dump-tasdeeq-202607241017.sql pm2 start ecosystem.config.cjs --only restore-dump"
  exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "ERROR: dump file not found: $DUMP_FILE"
  exit 1
fi

echo "Restoring $DUMP_FILE -> container=$CONTAINER db=$DB_NAME user=$DB_USER"
echo "Started at $(date -Is)"

# Create DB if missing (ignore error if already exists)
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME;" 2>/dev/null || true

cat "$DUMP_FILE" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"

echo "Finished at $(date -Is)"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT pg_size_pretty(pg_database_size('$DB_NAME'));"
