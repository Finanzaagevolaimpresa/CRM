#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Linux CI/operator test orchestrator. Only explicitly supplied, prebuilt images;
# dependency acquisition finishes before the network-isolated test starts.
: "${N05_RECOVERY_SYNTHETIC_CONFIRMED:?explicit synthetic test authorization required}"
[[ "$N05_RECOVERY_SYNTHETIC_CONFIRMED" == 1 ]]
: "${N05_RECOVERY_RUNNER_IMAGE:?prebuilt recovery-runner image required}"
: "${N05_RECOVERY_APP_IMAGE:?prebuilt real application source image required}"
: "${N05_RECOVERY_POSTGRES_IMAGE:?pinned PostgreSQL image required}"
: "${N05_RECOVERY_DOCUMENT_HELPER_IMAGE:?pinned GNU tar document helper required}"
[[ "$(hostname)" != fai-crm-prod-02 ]]
ROOT="$(git rev-parse --show-toplevel)"
HEAD="$(git rev-parse HEAD)"
[[ -z "$(git ls-tree "$HEAD" -- 'CRM TXT.txt')" ]]
RUN_ID="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
NETWORK="fai-crm-recovery-test-$RUN_ID"
RUNNER="fai-crm-recovery-runner-$RUN_ID"
PROJECT="fai-crm-restore-$RUN_ID-source"
LABEL="it.finanzaagevolaimpresa.recovery-test"
CONTEXT=""
docker() { command docker --host unix:///var/run/docker.sock "$@"; }
[[ "$(docker info --format '{{.Name}}')" != fai-crm-prod-02 ]]
ENGINE_ID="$(docker info --format '{{.ID}}')"
for image in "$N05_RECOVERY_RUNNER_IMAGE" "$N05_RECOVERY_APP_IMAGE" "$N05_RECOVERY_POSTGRES_IMAGE"; do
  docker image inspect "$image" >/dev/null
done
[[ -z "$(docker network ls -q --filter "name=^$NETWORK$")" ]]
[[ -z "$(docker ps -aq --filter "name=^/$RUNNER$")" ]]
NETWORK_ID=""
RUNNER_ID=""
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$RUNNER_ID" ]]; then
    [[ "$(docker inspect -f "{{index .Config.Labels \"$LABEL\"}}" "$RUNNER_ID")" == "$RUN_ID" ]] || exit 1
    docker rm -f "$RUNNER_ID" >/dev/null || exit 1
  fi
  if [[ -n "$NETWORK_ID" ]]; then
    [[ "$(docker network inspect -f "{{index .Labels \"$LABEL\"}}" "$NETWORK_ID")" == "$RUN_ID" ]] || exit 1
    # Refuse removal while any failed fixture is still attached.
    [[ "$(docker network inspect -f '{{len .Containers}}' "$NETWORK_ID")" == 0 ]] || exit 1
    docker network rm "$NETWORK_ID" >/dev/null || exit 1
  fi
  if [[ -n "$CONTEXT" ]]; then
    [[ "$CONTEXT" == /tmp/fai-crm-n05-context.* && -d "$CONTEXT" && ! -L "$CONTEXT" ]] || exit 1
    find "$CONTEXT" -depth -mindepth 1 -delete
    rmdir "$CONTEXT"
  fi
  exit "$result"
}
trap cleanup EXIT
CONTEXT="$(mktemp -d /tmp/fai-crm-n05-context.XXXXXX)"
image_source="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$N05_RECOVERY_APP_IMAGE")"
python3 -B tests/n05/prepare_recovery_context.py --image-source "$image_source" --destination "$CONTEXT/repo"
NETWORK_ID="$(docker network create --internal --label "$LABEL=$RUN_ID" \
  --label "com.docker.compose.project=$PROJECT" \
  --label it.finanzaagevolaimpresa.environment=restore-source \
  --label it.finanzaagevolaimpresa.sentinel=FAI_CRM_N05_RESTORE_SOURCE_V1 "$NETWORK")"
RUNNER_ID="$(docker create --pull never --name "$RUNNER" --hostname "$RUNNER" \
  --label "$LABEL=$RUN_ID" --network "$NETWORK" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount "type=bind,src=$CONTEXT/repo,dst=/input,readonly" \
  -e N05_RECOVERY_SYNTHETIC_CONFIRMED=1 -e "N05_RECOVERY_TEST_ID=$RUN_ID" \
  -e "N05_RECOVERY_ENGINE_ID=$ENGINE_ID" \
  -e "N05_RECOVERY_TEST_NETWORK=$NETWORK" -e "N05_RECOVERY_RUNNER_IMAGE=$N05_RECOVERY_RUNNER_IMAGE" \
  -e "N05_RECOVERY_APP_IMAGE=$N05_RECOVERY_APP_IMAGE" \
  -e "N05_RECOVERY_POSTGRES_IMAGE=$N05_RECOVERY_POSTGRES_IMAGE" \
  -e "N05_RECOVERY_DOCUMENT_HELPER_IMAGE=$N05_RECOVERY_DOCUMENT_HELPER_IMAGE" \
  --entrypoint sh "$N05_RECOVERY_RUNNER_IMAGE" -ceu '
    cp -a --no-preserve=ownership /input /workspace/repo
    test "$(git -C /workspace/repo rev-parse HEAD)" = "$1"
    cd /workspace/repo
    exec python3 -B tests/n05/recovery_drill.py
  ' sh "$HEAD")"
docker start --attach "$RUNNER_ID"
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$RUNNER_ID")" == 0 ]]
