#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DOCUMENT_ROOT="${LOCAL_DOCUMENT_STORAGE_ROOT:-./storage/private/documents}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required for PostgreSQL backup" >&2
  exit 1
fi

DB_BACKUP="$BACKUP_DIR/postgres-$TIMESTAMP.dump"
DOC_BACKUP="$BACKUP_DIR/documents-$TIMESTAMP.tar.gz"

pg_dump --format=custom --no-owner --no-privileges --file="$DB_BACKUP" "$DATABASE_URL"

echo "PostgreSQL backup written to $DB_BACKUP"

if [[ -d "$DOCUMENT_ROOT" ]]; then
  tar -czf "$DOC_BACKUP" -C "$DOCUMENT_ROOT" .
  echo "Document storage backup written to $DOC_BACKUP"
else
  echo "Document storage root not found, skipped: $DOCUMENT_ROOT" >&2
fi
