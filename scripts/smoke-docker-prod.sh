#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.example.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fai-crm}"
APP_SERVICE="${APP_SERVICE:-app}"
DOCUMENTS_PATH="${DOCUMENTS_PATH:-/var/lib/fai-crm/documents}"

compose() {
  docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose config --quiet
compose build "$APP_SERVICE"
compose run --rm --entrypoint sh "$APP_SERVICE" -c \
  'node -e "require.resolve(\"prisma\"); require.resolve(\"tsx\")" && test -f prisma/schema.prisma && test -f prisma/seed-production.ts && test -f scripts/bootstrap-admin.ts && test -w "$1"' \
  sh "$DOCUMENTS_PATH"

echo "Docker production smoke test completed. Run real migrate/seed/admin commands separately against the intended database."
