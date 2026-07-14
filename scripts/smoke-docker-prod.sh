#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.example.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fai-crm}"
APP_SERVICE="${APP_SERVICE:-app}"
DOCUMENTS_PATH="${DOCUMENTS_PATH:-/var/lib/fai-crm/documents}"

cleanup_env_file=""
if [[ ! -f "$ENV_FILE" ]]; then
  cleanup_env_file="$ENV_FILE"
  cat > "$ENV_FILE" <<'ENV'
POSTGRES_DB=fai_crm
POSTGRES_USER=fai_crm
POSTGRES_PASSWORD=fai_crm_smoke_password
DATABASE_URL=postgresql://fai_crm:fai_crm_smoke_password@postgres:5432/fai_crm?schema=public
AUTH_SECRET=smoke-test-secret-not-for-production
AUTH_COOKIE_NAME=fai_crm_session
AI_PROVIDER=mock
ENV
fi

cleanup() {
  docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "$cleanup_env_file" ]]; then
    rm -f "$cleanup_env_file"
  fi
}
trap cleanup EXIT

compose() {
  docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose config --quiet
compose build "$APP_SERVICE"
compose up -d postgres
compose run --rm --entrypoint sh "$APP_SERVICE" -c \
  'node -e "require.resolve(\"prisma\"); require.resolve(\"tsx\")" && test -f prisma/schema.prisma && test -f prisma/seed-production.ts && test -f scripts/bootstrap-admin.ts && test -f src/lib/prisma.ts && test -f src/lib/ai-run-reliability.ts && test -w "$1"' \
  sh "$DOCUMENTS_PATH"
compose run --rm "$APP_SERVICE" npm run prisma:migrate:deploy
compose run --rm "$APP_SERVICE" npm run prisma:seed:production
reconcile_output="$(compose run --rm "$APP_SERVICE" npm run --silent ai:reconcile)"
if [[ "$reconcile_output" != '{"reconciledRuns":0}' ]]; then
  echo "Unexpected ai:reconcile output: $reconcile_output" >&2
  exit 1
fi

echo "Docker production smoke test completed: migrations, production seed, and ai:reconcile succeeded in the final runner image."
