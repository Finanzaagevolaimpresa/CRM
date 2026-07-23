#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.example.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fai-crm-smoke-${GITHUB_RUN_ID:-$$}}"
APP_SERVICE="${APP_SERVICE:-app}"
DOCUMENTS_PATH="${DOCUMENTS_PATH:-/var/lib/fai-crm/documents}"
EXPECTED_MIGRATION_COUNT=29
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
    while IFS= read -r container; do
      [[ -n "$container" ]] && docker rm -f "$container" >/dev/null 2>&1 || true
    done < <(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")

    while IFS= read -r network; do
      [[ -n "$network" ]] && docker network rm "$network" >/dev/null 2>&1 || true
    done < <(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")

    while IFS= read -r volume; do
      [[ -n "$volume" ]] && docker volume rm "$volume" >/dev/null 2>&1 || true
    done < <(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")

    docker image rm "$SMOKE_APP_IMAGE" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SMOKE_ENV_FILE" ]]; then
    rm -f "$SMOKE_ENV_FILE"
  fi
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail "docker is required for the production smoke test"
command -v timeout >/dev/null 2>&1 || fail "timeout is required for bounded worker smoke tests"
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
AI_ORCHESTRATOR_WORKER_ENABLED=0
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
export AI_ORCHESTRATOR_WORKER_ENABLED=0
export AI_API_KEY=
export APP_ENV=production
export NODE_ENV=production

compose() {
  docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$SMOKE_ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose config --quiet
mapfile -t COMPOSE_SERVICES < <(compose config --services | LC_ALL=C sort)
if [[ "${#COMPOSE_SERVICES[@]}" -ne 2 || "${COMPOSE_SERVICES[0]}" != "app" || "${COMPOSE_SERVICES[1]}" != "postgres" ]]; then
  fail "Production Compose must define exactly the app and postgres services"
fi

compose build "$APP_SERVICE"
SMOKE_CREATED="true"
compose up -d postgres
compose run --rm -T --entrypoint sh "$APP_SERVICE" -c \
  'node -e "require.resolve(\"prisma\"); require.resolve(\"tsx\"); let sharpPresent=true; try{require.resolve(\"sharp\")}catch(error){if(error.code!==\"MODULE_NOT_FOUND\")throw error;sharpPresent=false} if(sharpPresent)process.exit(1); const p=require(\"./package.json\"); if(p.scripts[\"ai:orchestrator:worker\"]!==\"tsx scripts/ai-orchestrator-worker.ts\") process.exit(1)" && test ! -e node_modules/sharp && test ! -e node_modules/@img && test -z "$(find node_modules -type d \( -path "*/node_modules/sharp" -o -path "*/node_modules/@img" \) -print -quit)" && test -f prisma/schema.prisma && test -f prisma/seed-production.ts && test -f scripts/bootstrap-admin.ts && test -f scripts/ai-orchestrator-worker.ts && test -f src/lib/prisma.ts && test -f src/lib/ai-run-reliability.ts && test -f src/lib/ai-orchestrator/dormant-worker-process-v1.ts && test -f src/lib/ai-orchestrator/worker-admission-claim-lease-process-v1.ts && test -f src/lib/ai-orchestrator/worker-admission-claim-lease-wiring-v1.ts && test -f src/lib/ai-orchestrator/worker-control-plane-authority-v1.ts && test -f src/lib/ai-orchestrator/worker-runtime-adapter-v1.ts && test "$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d " ")" = "$2" && test "${AI_PROVIDER:-}" = "mock" && test "${AI_ORCHESTRATOR_WORKER_ENABLED:-}" = "0" && test "${AI_EXTERNAL_PROVIDERS_ENABLED:-}" = "false" && test -z "${AI_ALLOWED_MODELS:-}" && test -w "$1"' \
  sh "$DOCUMENTS_PATH" "$EXPECTED_MIGRATION_COUNT"

DORMANT_WORKER_CONTAINER="${COMPOSE_PROJECT_NAME}-dormant-worker"
LOCKED_WORKER_CONTAINER="${COMPOSE_PROJECT_NAME}-locked-worker"
for container_name in "$DORMANT_WORKER_CONTAINER" "$LOCKED_WORKER_CONTAINER"; do
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    fail "Container $container_name already exists; refusing to replace it"
  fi
done

docker run -d \
  --name "$DORMANT_WORKER_CONTAINER" \
  --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -e APP_ENV=production \
  -e NODE_ENV=production \
  -e AI_PROVIDER=mock \
  -e AI_ORCHESTRATOR_WORKER_ENABLED=0 \
  -e AI_EXTERNAL_PROVIDERS_ENABLED=false \
  -e AI_ALLOWED_MODELS= \
  -e 'DATABASE_URL=postgresql://127.0.0.1:1/must-not-connect?schema=public' \
  --entrypoint node \
  "$SMOKE_APP_IMAGE" \
  --import tsx scripts/ai-orchestrator-worker.ts >/dev/null

DORMANT_LOGS=""
for _ in $(seq 1 150); do
  DORMANT_LOGS="$(docker logs "$DORMANT_WORKER_CONTAINER" 2>&1)"
  if printf '%s\n' "$DORMANT_LOGS" | grep -Fq '"state":"DORMANT"'; then
    break
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$DORMANT_WORKER_CONTAINER")" == "true" ]] \
    || fail "Dormant worker exited before its initial heartbeat: $DORMANT_LOGS"
  sleep 0.1
done

printf '%s\n' "$DORMANT_LOGS" | grep -Fq '"state":"DORMANT"' \
  || fail "Dormant worker did not emit its initial heartbeat"
docker kill --signal=TERM "$DORMANT_WORKER_CONTAINER" >/dev/null
DORMANT_EXIT="$(timeout --kill-after=5s 15s docker wait "$DORMANT_WORKER_CONTAINER")" \
  || fail "Dormant worker did not exit within 15s after SIGTERM"
[[ "$DORMANT_EXIT" == "0" ]] \
  || fail "Dormant worker did not stop cleanly after SIGTERM"
DORMANT_LOGS="$(docker logs "$DORMANT_WORKER_CONTAINER" 2>&1)"
printf '%s\n' "$DORMANT_LOGS" | node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length !== 1) process.exit(1);
  const row = JSON.parse(lines[0]);
  const keys = ["schemaVersion", "workerProcessVersion", "workerInstanceId", "workerBuildHash", "state", "sequence", "timestamp"];
  if (JSON.stringify(Object.keys(row)) !== JSON.stringify(keys)) process.exit(1);
  if (row.schemaVersion !== 1 || row.workerProcessVersion !== "1.0" || row.state !== "DORMANT" || row.sequence !== 1) process.exit(1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.workerInstanceId)) process.exit(1);
  if (!/^[0-9a-f]{64}$/.test(row.workerBuildHash)) process.exit(1);
' || fail "Dormant worker heartbeat is not canonical"
if printf '%s\n' "$DORMANT_LOGS" | grep -Eqi 'postgresql|must-not-connect|database_url|secret|stack|payload|url'; then
  fail "Dormant worker logs contain prohibited data"
fi
docker rm "$DORMANT_WORKER_CONTAINER" >/dev/null

compose run --rm -T "$APP_SERVICE" npm run prisma:migrate:deploy
compose run --rm -T "$APP_SERVICE" npm run prisma:seed:production

orchestrator_snapshot() {
  compose exec -T postgres psql \
    -v ON_ERROR_STOP=1 \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -Atq <<'SQL'
SELECT 'AiOrchestratorSetting:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiOrchestratorSetting" t), '[]');
SELECT 'AiControlSetting:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiControlSetting" t), '[]');
SELECT 'AiOrchestratorWorkerCapabilitySetting:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiOrchestratorWorkerCapabilitySetting" t), '[]');
SELECT 'AiOrchestratorAdminPolicyRevision:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiOrchestratorAdminPolicyRevision" t), '[]');
SELECT 'AiWorkflowInstance:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowInstance" t), '[]');
SELECT 'AiWorkflowCommand:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowCommand" t), '[]');
SELECT 'AiWorkflowTransition:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowTransition" t), '[]');
SELECT 'AiWorkflowJob:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowJob" t), '[]');
SELECT 'AiWorkflowJobOutboxEvent:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowJobOutboxEvent" t), '[]');
SELECT 'AiWorkflowJobRuntime:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowJobRuntime" t), '[]');
SELECT 'AiWorkflowJobAttempt:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowJobAttempt" t), '[]');
SELECT 'AiWorkflowOutboxConsumption:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowOutboxConsumption" t), '[]');
SELECT 'AiWorkflowJobRuntimeEvent:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowJobRuntimeEvent" t), '[]');
SELECT 'AiWorkflowJobResult:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowJobResult" t), '[]');
SELECT 'AiWorkflowJobArtifact:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowJobArtifact" t), '[]');
SELECT 'AiWorkflowJobSourceArtifact:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiWorkflowJobSourceArtifact" t), '[]');
SELECT 'AiRun:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiRun" t), '[]');
SELECT 'AiOutput:' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text FROM "AiOutput" t), '[]');
SQL
}

LOCKED_SNAPSHOT_BEFORE="$(orchestrator_snapshot)"
mapfile -t SMOKE_NETWORKS < <(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
[[ "${#SMOKE_NETWORKS[@]}" -eq 1 ]] || fail "Expected exactly one isolated Compose network"

docker run -d \
  --name "$LOCKED_WORKER_CONTAINER" \
  --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${SMOKE_NETWORKS[0]}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -e APP_ENV=production \
  -e NODE_ENV=production \
  -e AI_PROVIDER=mock \
  -e AI_ORCHESTRATOR_WORKER_ENABLED=1 \
  -e AI_EXTERNAL_PROVIDERS_ENABLED=false \
  -e AI_ALLOWED_MODELS= \
  -e "DATABASE_URL=$DATABASE_URL" \
  --entrypoint node \
  "$SMOKE_APP_IMAGE" \
  --import tsx scripts/ai-orchestrator-worker.ts >/dev/null

for _ in $(seq 1 75); do
  LOCKED_LOGS="$(docker logs "$LOCKED_WORKER_CONTAINER" 2>&1)"
  [[ -z "$LOCKED_LOGS" ]] \
    || fail "Gate 1 worker emitted unexpected output before shutdown"
  [[ "$(docker inspect -f '{{.State.Running}}' "$LOCKED_WORKER_CONTAINER")" == "true" ]] \
    || fail "Gate 1 worker exited before completing the bounded FOUNDATION_LOCKED cycle"
  sleep 0.1
done

[[ "$(docker inspect -f '{{.State.Running}}' "$LOCKED_WORKER_CONTAINER")" == "true" ]] \
  || fail "Gate 1 worker did not remain alive through the bounded FOUNDATION_LOCKED cycle"
docker kill --signal=TERM "$LOCKED_WORKER_CONTAINER" >/dev/null
LOCKED_EXIT="$(timeout --kill-after=5s 15s docker wait "$LOCKED_WORKER_CONTAINER")" \
  || fail "Gate 1 worker did not terminate within the bounded smoke window"
[[ "$LOCKED_EXIT" == "0" ]] \
  || fail "Gate 1 worker did not stop cleanly after SIGTERM; status $LOCKED_EXIT"

LOCKED_LOGS="$(docker logs "$LOCKED_WORKER_CONTAINER" 2>&1)"
[[ -z "$LOCKED_LOGS" ]] || fail "Gate 1 worker emitted unexpected output"

LOCKED_SNAPSHOT_AFTER="$(orchestrator_snapshot)"
[[ "$LOCKED_SNAPSHOT_BEFORE" == "$LOCKED_SNAPSHOT_AFTER" ]] \
  || fail "Gate 1 changed Orchestrator, result, AiRun, or AiOutput state while FOUNDATION_LOCKED_V1"
docker rm "$LOCKED_WORKER_CONTAINER" >/dev/null

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

compose up -d "$APP_SERVICE"

APP_HEALTH_JSON=""
for _ in $(seq 1 120); do
  if APP_HEALTH_JSON="$(compose exec -T "$APP_SERVICE" node -e '
    fetch("http://127.0.0.1:3000/api/health")
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        process.stdout.write(await response.text());
      })
      .catch(() => process.exit(1));
  ' 2>/dev/null)"; then
    break
  fi
  sleep 0.5
done
[[ -n "$APP_HEALTH_JSON" ]] || fail "Application did not become healthy within 60 seconds"
printf '%s\n' "$APP_HEALTH_JSON" | node -e '
  const fs = require("node:fs");
  const row = JSON.parse(fs.readFileSync(0, "utf8"));
  if (row.ok !== true || row.status !== "ok" || row.app !== "fai-crm" || row.database?.reachable !== true) process.exit(1);
' || fail "Application health response is not canonical"

IMAGE_OPTIMIZER_STATUS="$(compose exec -T "$APP_SERVICE" node -e '
  fetch("http://127.0.0.1:3000/_next/image?url=%2Flogo-fai.png&w=64&q=75")
    .then((response) => process.stdout.write(String(response.status)))
    .catch(() => process.exit(1));
')"
[[ "$IMAGE_OPTIMIZER_STATUS" == "404" ]] \
  || fail "Next.js image optimizer endpoint must remain closed; received HTTP $IMAGE_OPTIMIZER_STATUS"

mapfile -t RUNNING_SERVICES < <(compose ps --services --status running | LC_ALL=C sort)
if [[ "${#RUNNING_SERVICES[@]}" -ne 2 || "${RUNNING_SERVICES[0]}" != "app" || "${RUNNING_SERVICES[1]}" != "postgres" ]]; then
  fail "Only app and postgres may be running after production Compose startup"
fi
if docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Names}}' | grep -Eqi 'worker|orchestrator'; then
  fail "Production Compose started an unauthorized worker or Orchestrator container"
fi

echo "Docker production smoke test completed: 29 migrations, production seed, app health, closed image optimizer, ai:reconcile, fail-closed worker gates, and cleanup succeeded for $COMPOSE_PROJECT_NAME."
