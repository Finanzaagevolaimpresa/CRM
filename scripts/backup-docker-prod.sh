#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.example.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
BACKUP_DIR="${BACKUP_DIR:-./backups/docker-prod}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
APP_SERVICE="${APP_SERVICE:-app}"
DOCUMENT_VOLUME="${DOCUMENT_VOLUME:-crm_crm_documents}"
POSTGRES_DB="${POSTGRES_DB:-fai_crm}"
POSTGRES_USER="${POSTGRES_USER:-fai_crm}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

DB_BACKUP="$BACKUP_DIR/postgres-$TIMESTAMP.dump"
DOC_BACKUP="$BACKUP_DIR/documents-$TIMESTAMP.tar.gz"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "Creating PostgreSQL custom-format backup..."
compose exec -T "$POSTGRES_SERVICE" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$DB_BACKUP"
chmod 600 "$DB_BACKUP"
echo "PostgreSQL backup written to $DB_BACKUP"

if docker volume inspect "$DOCUMENT_VOLUME" >/dev/null 2>&1; then
  echo "Creating documents volume archive..."
  docker run --rm \
    -v "$DOCUMENT_VOLUME:/documents:ro" \
    -v "$(cd "$BACKUP_DIR" && pwd):/backup" \
    alpine:3.20 \
    tar -czf "/backup/$(basename "$DOC_BACKUP")" -C /documents .
  chmod 600 "$DOC_BACKUP"
  echo "Documents backup written to $DOC_BACKUP"
else
  echo "Warning: Docker volume '$DOCUMENT_VOLUME' does not exist; documents archive skipped." >&2
fi

find "$BACKUP_DIR" -type f \( -name 'postgres-*.dump' -o -name 'documents-*.tar.gz' \) -mtime +"$RETENTION_DAYS" -print -delete
