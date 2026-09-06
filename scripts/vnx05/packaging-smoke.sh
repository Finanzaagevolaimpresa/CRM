#!/usr/bin/env bash
set -Eeuo pipefail

# Test-only qualification of the actual pruned application image and entrypoint.
[[ "${VNX05_SYNTHETIC_TESTS_CONFIRMED:-}" == 1 ]] || {
  echo 'VNX05_SYNTHETIC_CONFIRMATION_REQUIRED' >&2
  exit 1
}
root="$(git rev-parse --show-toplevel)"
cd "$root"
node scripts/vnx00a-build-context-guard.mjs
source_commit="$(git rev-parse HEAD)"
source_tree="$(git rev-parse HEAD^{tree})"
run_id="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
[[ "$run_id" =~ ^[a-zA-Z0-9-]+$ ]] || exit 1
project="fai-vnx05-synthetic-$run_id"
image="fai-crm:vnx05-synthetic-$run_id"
database="$project-postgres"
consumer="$project-consumer"
network="$project-internal"
image_created=0
network_created=0
database_created=0
consumer_created=0

for container in "$database" "$consumer"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    echo 'VNX05_SYNTHETIC_CONTAINER_COLLISION' >&2; exit 1
  fi
done
if docker network inspect "$network" >/dev/null 2>&1 || docker image inspect "$image" >/dev/null 2>&1; then
  echo 'VNX05_SYNTHETIC_RESOURCE_COLLISION' >&2; exit 1
fi

cleanup() {
  local result=$?
  trap - EXIT
  if (( consumer_created )); then docker rm -f "$consumer" >/dev/null || result=1; fi
  if (( database_created )); then docker rm -f "$database" >/dev/null || result=1; fi
  if (( network_created )); then docker network rm "$network" >/dev/null || result=1; fi
  if (( image_created )); then docker image rm "$image" >/dev/null || result=1; fi
  echo "VNX05_SYNTHETIC_CLEANUP_EXIT=$result"
  exit "$result"
}
trap cleanup EXIT

docker build --build-arg "SOURCE_COMMIT=$source_commit" --build-arg "SOURCE_TREE=$source_tree" \
  -f Dockerfile.prod.example -t "$image" .
image_created=1
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$source_commit"
test "$(docker image inspect "$image" --format '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}')" = "$source_tree"
docker network create --internal --label "fai.vnx05.synthetic=$project" "$network" >/dev/null
network_created=1
docker run -d --name "$database" --label "fai.vnx05.synthetic=$project" --network "$network" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1g \
  -e POSTGRES_DB=fai_crm_test -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=synthetic-vnx05-only \
  --health-cmd='pg_isready -U postgres -d fai_crm_test' --health-interval=2s \
  --health-timeout=2s --health-retries=20 postgres:16 >/dev/null
database_created=1
for ((attempt=0; attempt<30; attempt++)); do
  health="$(docker inspect "$database" --format '{{.State.Health.Status}}')"
  [[ "$health" == healthy ]] && break
  sleep 1
done
[[ "$health" == healthy ]]
test "$(docker network inspect "$network" --format '{{.Internal}}')" = true
test "$(docker exec "$database" psql -U postgres -d fai_crm_test -Atc 'SELECT current_database()')" = fai_crm_test
docker exec "$database" psql -U postgres -d fai_crm_test -v ON_ERROR_STOP=1 \
  -c "COMMENT ON DATABASE fai_crm_test IS 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1';" >/dev/null
echo 'VNX05_SYNTHETIC_DATABASE=fai_crm_test; NETWORK=internal; STORAGE=tmpfs; PUBLISHED_PORTS=none'

# Only test code is mounted. All application modules, scripts, Prisma migrations
# and production dependencies come from the immutable image under qualification.
docker create --name "$consumer" --label "fai.vnx05.synthetic=$project" --network "container:$database" \
  --tmpfs /run/secrets:rw,noexec,nosuid,uid=1001,gid=1001,mode=0700,size=2m \
  --mount "type=bind,source=$root/tests,target=/app/tests,readonly" \
  -e DATABASE_URL='postgresql://postgres:synthetic-vnx05-only@localhost:5432/fai_crm_test?schema=public' \
  -e APP_ENV=test -e NODE_ENV=test -e RUN_DB_TESTS=1 -e AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1 \
  -e AI_ORCHESTRATOR_DB_TEST_SENTINEL=FAI_CRM_EPHEMERAL_TEST_ONLY_V1 \
  -e VNX05_PACKAGED_TESTS=1 -e COMMERCIAL_LEAD_INBOX_MODE=disabled \
  -e WEBSITE_LEAD_MODE=disabled -e AI_ORCHESTRATOR_WORKER_ENABLED=0 \
  -e AI_EXTERNAL_PROVIDERS_ENABLED=false -e FEATURE_AI_WORKER_ENABLED=false \
  -e FEATURE_AI_DISPATCH_ENABLED=false -e FEATURE_AI_EGRESS_ENABLED=false \
  -e SECURE_LEAD_GATEWAY_MODE=disabled "$image" npm run test:vnx05:db >/dev/null
consumer_created=1
docker start -a "$consumer"
test "$(docker inspect "$consumer" --format '{{.State.ExitCode}}')" = 0
