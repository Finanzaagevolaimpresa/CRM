#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.example.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fai-crm-smoke-${GITHUB_RUN_ID:-$$}}"
APP_SERVICE="${APP_SERVICE:-app}"
DOCUMENTS_PATH="${DOCUMENTS_PATH:-/var/lib/fai-crm/documents}"
SMOKE_ENV_FILE=""
SMOKE_APP_IMAGE="${APP_IMAGE:-fai-crm:smoke-${COMPOSE_PROJECT_NAME}}"
SMOKE_CREATED="false"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

case "$COMPOSE_PROJECT_NAME" in
  fai-crm|production|prod) fail "Refusing unsafe COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME" ;;
esac
[[ "$COMPOSE_PROJECT_NAME" =~ ^fai-crm-smoke-[A-Za-z0-9_.-]+$ ]] || fail "COMPOSE_PROJECT_NAME must match ^fai-crm-smoke-[A-Za-z0-9_.-]+$"

if [[ "${ENV_FILE:-}" == "/opt/fai-crm/.env.production" || "${APP_ENV_FILE:-}" == "/opt/fai-crm/.env.production" ]]; then
  fail "Refusing to use /opt/fai-crm/.env.production for smoke tests"
fi
if [[ "${ENV_FILE:-}" == ".env.production" || "${APP_ENV_FILE:-}" == ".env.production" || -f .env.production ]]; then
  fail "Refusing to read, modify, or delete a real .env.production; run this smoke test in CI or an ephemeral workspace"
fi

resource_count() {
  local containers networks volumes
  containers="$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
  networks="$(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
  volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
  printf '%s\n%s\n%s\n' "$containers" "$networks" "$volumes" | sed '/^$/d' | wc -l | tr -d ' '
}

cleanup() {
  set +e
  if [[ "$SMOKE_CREATED" == "true" ]]; then
    docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$SMOKE_ENV_FILE" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
    docker image rm "$SMOKE_APP_IMAGE" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SMOKE_ENV_FILE" ]]; then
    rm -f "$SMOKE_ENV_FILE"
  fi
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "docker is required for the production smoke test"
[[ "$(resource_count)" == "0" ]] || fail "Compose resources already exist for $COMPOSE_PROJECT_NAME; refusing to touch a pre-existing project"
if docker image inspect "$SMOKE_APP_IMAGE" >/dev/null 2>&1; then
  fail "Image $SMOKE_APP_IMAGE already exists; refusing to remove or overwrite a pre-existing image"
fi

SMOKE_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/fai-crm-smoke-env.XXXXXX")"
chmod 600 "$SMOKE_ENV_FILE"
cat > "$SMOKE_ENV_FILE" <<'ENV'
POSTGRES_DB=fai_crm_smoke
POSTGRES_USER=fai_crm_smoke
POSTGRES_PASSWORD=fai_crm_smoke_password
DATABASE_URL=postgresql://fai_crm_smoke:fai_crm_smoke_password@postgres:5432/fai_crm_smoke?schema=public
AUTH_SECRET=smoke-test-secret-not-for-production
AUTH_COOKIE_NAME=fai_crm_smoke_session
AI_PROVIDER=mock
AI_EXTERNAL_PROVIDERS_ENABLED=false
AI_ALLOWED_MODELS=
AI_API_KEY=
APP_ENV=production
NODE_ENV=production
ENV

export APP_IMAGE="$SMOKE_APP_IMAGE"
export APP_ENV_FILE="$SMOKE_ENV_FILE"
export POSTGRES_DB=fai_crm_smoke
export POSTGRES_USER=fai_crm_smoke
export POSTGRES_PASSWORD=fai_crm_smoke_password
export DATABASE_URL=postgresql://fai_crm_smoke:fai_crm_smoke_password@postgres:5432/fai_crm_smoke?schema=public
export AUTH_SECRET=smoke-test-secret-not-for-production
export AUTH_COOKIE_NAME=fai_crm_smoke_session
export AI_PROVIDER=mock
export AI_EXTERNAL_PROVIDERS_ENABLED=false
export AI_ALLOWED_MODELS=
export AI_API_KEY=
export APP_ENV=production
export NODE_ENV=production

compose() {
  docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$SMOKE_ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose config --quiet
compose build "$APP_SERVICE"
SMOKE_CREATED="true"
compose up -d postgres
compose run --rm -T --entrypoint sh "$APP_SERVICE" -c \
  'node -e "require.resolve(\"prisma\"); require.resolve(\"tsx\")" && test -f prisma/schema.prisma && test -f prisma/seed-production.ts && test -f scripts/bootstrap-admin.ts && test -f src/lib/prisma.ts && test -f src/lib/ai-run-reliability.ts && test -w "$1"' \
  sh "$DOCUMENTS_PATH"
compose run --rm -T "$APP_SERVICE" npm run prisma:migrate:deploy
compose run --rm -T "$APP_SERVICE" npm run prisma:seed:production
reconcile_log="$(mktemp "${TMPDIR:-/tmp}/fai-crm-reconcile-log.XXXXXX")"
if ! compose run --rm -T "$APP_SERVICE" npm run --silent ai:reconcile > "$reconcile_log" 2>&1; then
  cat "$reconcile_log" >&2
  rm -f "$reconcile_log"
  fail "ai:reconcile failed in the production runner image"
fi
cat "$reconcile_log"
if ! grep -Fxq '{"reconciledRuns":0}' "$reconcile_log"; then
  rm -f "$reconcile_log"
  fail "ai:reconcile did not emit an exact {\"reconciledRuns\":0} line"
fi
rm -f "$reconcile_log"

echo "Docker production smoke test completed: isolated migrations, production seed, ai:reconcile, and cleanup succeeded for $COMPOSE_PROJECT_NAME."
