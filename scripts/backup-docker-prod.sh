#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.example.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fai-crm}"
BACKUP_DIR="${BACKUP_DIR:-./backups/docker-prod}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
APP_SERVICE="${APP_SERVICE:-app}"
DOCUMENTS_PATH="${DOCUMENTS_PATH:-/var/lib/fai-crm/documents}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DOCUMENTS_STATUS=0

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd)"

DB_BACKUP="$BACKUP_DIR_ABS/postgres-$TIMESTAMP.dump"
DOC_BACKUP="$BACKUP_DIR_ABS/documents-$TIMESTAMP.tar.gz"

compose() {
  docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "Creating PostgreSQL custom-format backup..."
compose exec -T "$POSTGRES_SERVICE" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DB_BACKUP"
chmod 600 "$DB_BACKUP"
echo "PostgreSQL backup written to $DB_BACKUP"

echo "Creating documents archive from $APP_SERVICE:$DOCUMENTS_PATH..."
if compose exec -T "$APP_SERVICE" sh -c 'test -d "$1" && tar -czf - -C "$1" .' sh "$DOCUMENTS_PATH" > "$DOC_BACKUP"; then
  chmod 600 "$DOC_BACKUP"
  echo "Documents backup written to $DOC_BACKUP"
else
  DOCUMENTS_STATUS=$?
  rm -f "$DOC_BACKUP"
  echo "Warning: documents directory '$DOCUMENTS_PATH' is not available from service '$APP_SERVICE'; documents archive skipped and database backup kept." >&2
fi

find "$BACKUP_DIR_ABS" -type f \( -name 'postgres-*.dump' -o -name 'documents-*.tar.gz' \) -mtime +"$RETENTION_DAYS" -print -delete

if [ "$DOCUMENTS_STATUS" -ne 0 ]; then
  exit 2
fi
