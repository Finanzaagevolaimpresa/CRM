#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

: "${FAI_ENVIRONMENT:?FAI_ENVIRONMENT is required}"
: "${FAI_ENVIRONMENT_SENTINEL:?FAI_ENVIRONMENT_SENTINEL is required}"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${ENV_FILE:?ENV_FILE is required}"
: "${APP_ENV_FILE:?APP_ENV_FILE is required}"
: "${APP_ORIGIN:?APP_ORIGIN is required}"
: "${APP_IMAGE:?APP_IMAGE is required}"
: "${SOURCE_COMMIT:?SOURCE_COMMIT is required}"
: "${SOURCE_TREE:?SOURCE_TREE is required}"
: "${EXPECTED_IMAGE_ID:?EXPECTED_IMAGE_ID is required}"
: "${CURRENT_APP_IMAGE:?CURRENT_APP_IMAGE is required}"
: "${EXPECTED_CURRENT_APP_IMAGE_ID:?EXPECTED_CURRENT_APP_IMAGE_ID is required}"
: "${POSTGRES_IMAGE:?POSTGRES_IMAGE is required}"
: "${CONFIRM_LEGACY_RESOURCE_IDENTITY:?CONFIRM_LEGACY_RESOURCE_IDENTITY is required}"

ACTION="${1:-}"
[[ "$#" -eq 1 && ( "$ACTION" == "preflight" || "$ACTION" == "switch-app" ) ]] \
  || n05_fail LEGACY_PRODUCTION_SWITCH_ACTION_INVALID

BASE_COMPOSE="$N05_REPO_ROOT/docker-compose.prod.example.yml"
LEGACY_OVERRIDE="$N05_REPO_ROOT/docker-compose.prod.legacy-resources.yml"
SWITCH_LOG=""

cleanup_switch_log() {
  set +e
  if [[ -n "$SWITCH_LOG" && "$SWITCH_LOG" =~ ^/tmp/fai-crm-n05-legacy-switch\.[A-Za-z0-9]+\.log$ \
    && -f "$SWITCH_LOG" && ! -L "$SWITCH_LOG" ]]; then
    rm -f -- "$SWITCH_LOG"
  fi
}
trap cleanup_switch_log EXIT

n05_require_command docker
n05_require_command git
n05_require_command grep
n05_require_command sed
n05_require_command sort
n05_require_command tail
n05_require_command mktemp
n05_require_command rm
n05_assert_environment_identity production
n05_assert_git_oid "$SOURCE_COMMIT" SOURCE_COMMIT
n05_assert_git_oid "$SOURCE_TREE" SOURCE_TREE
[[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || n05_fail EXPECTED_IMAGE_ID_INVALID
[[ "$EXPECTED_CURRENT_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || n05_fail EXPECTED_CURRENT_APP_IMAGE_ID_INVALID
[[ "$(n05_realpath "$COMPOSE_FILE")" == "$(n05_realpath "$BASE_COMPOSE")" ]] \
  || n05_fail LEGACY_SWITCH_BASE_COMPOSE_MISMATCH
[[ -f "$LEGACY_OVERRIDE" && ! -L "$LEGACY_OVERRIDE" ]] \
  || n05_fail LEGACY_SWITCH_OVERRIDE_NOT_REGULAR
[[ "$CONFIRM_LEGACY_RESOURCE_IDENTITY" == "FAI_CRM_N05_LEGACY_RESOURCE_BRIDGE_V1" ]] \
  || n05_fail LEGACY_RESOURCE_BRIDGE_CONFIRMATION_MISMATCH
[[ "$(git -C "$N05_REPO_ROOT" rev-parse "$SOURCE_COMMIT^{tree}")" == "$SOURCE_TREE" ]] \
  || n05_fail LEGACY_SWITCH_SOURCE_TREE_MISMATCH

compose_version="$(docker compose version --short | sed 's/^v//')"
if [[ "$compose_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  compose_major="${BASH_REMATCH[1]}"
  compose_minor="${BASH_REMATCH[2]}"
  compose_patch="${BASH_REMATCH[3]}"
else
  n05_fail COMPOSE_VERSION_INVALID
fi
if (( compose_major < 2 || (compose_major == 2 && compose_minor < 24) \
  || (compose_major == 2 && compose_minor == 24 && compose_patch < 4) )); then
  n05_fail COMPOSE_OVERRIDE_UNSUPPORTED
fi

mapfile -t app_ids < <(docker ps -q --no-trunc \
  --filter 'label=com.docker.compose.project=fai-crm' \
  --filter 'label=com.docker.compose.service=app')
mapfile -t postgres_ids < <(docker ps -q --no-trunc \
  --filter 'label=com.docker.compose.project=fai-crm' \
  --filter 'label=com.docker.compose.service=postgres')
[[ "${#app_ids[@]}" -eq 1 && "${#postgres_ids[@]}" -eq 1 ]] \
  || n05_fail LEGACY_SWITCH_RUNTIME_IDENTITY_MISMATCH
current_app_id="${app_ids[0]}"
postgres_id="${postgres_ids[0]}"
[[ "$(docker inspect -f '{{.Config.Image}}' "$current_app_id")" == "$CURRENT_APP_IMAGE" ]] \
  || n05_fail LEGACY_SWITCH_CURRENT_APP_TAG_MISMATCH
[[ "$(docker inspect -f '{{.Image}}' "$current_app_id")" == "$EXPECTED_CURRENT_APP_IMAGE_ID" ]] \
  || n05_fail LEGACY_SWITCH_CURRENT_APP_ID_MISMATCH
[[ "$(docker inspect -f '{{.State.Status}}' "$current_app_id")" == "running" ]] \
  || n05_fail LEGACY_SWITCH_CURRENT_APP_NOT_RUNNING
[[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$current_app_id")" == "healthy" ]] \
  || n05_fail LEGACY_SWITCH_CURRENT_APP_NOT_HEALTHY

(
  export APP_IMAGE="$CURRENT_APP_IMAGE"
  export EXPECTED_APP_IMAGE_ID="$EXPECTED_CURRENT_APP_IMAGE_ID"
  export BACKUP_RESOURCE_PROVENANCE=authorized-legacy-compose-identity
  n05_assert_authorized_legacy_compose_resources "$postgres_id" running >/dev/null
)

target_image_id="$(docker image inspect -f '{{.Id}}' "$APP_IMAGE")"
target_image_commit="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$APP_IMAGE")"
target_image_tree="$(docker image inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}' "$APP_IMAGE")"
[[ "$target_image_id" == "$EXPECTED_IMAGE_ID" ]] || n05_fail LEGACY_SWITCH_TARGET_IMAGE_ID_MISMATCH
[[ "$target_image_commit" == "$SOURCE_COMMIT" && "$target_image_tree" == "$SOURCE_TREE" ]] \
  || n05_fail LEGACY_SWITCH_TARGET_IMAGE_PROVENANCE_MISMATCH

compose_legacy() {
  docker compose -p "$COMPOSE_PROJECT_NAME" \
    --env-file "$ENV_FILE" \
    -f "$BASE_COMPOSE" \
    -f "$LEGACY_OVERRIDE" \
    "$@"
}

compose_legacy config --quiet </dev/null
mapfile -t compose_services < <(compose_legacy config --services | LC_ALL=C sort)
mapfile -t compose_volumes < <(compose_legacy config --volumes | LC_ALL=C sort)
[[ "${compose_services[*]}" == "app postgres" ]] || n05_fail LEGACY_SWITCH_COMPOSE_SERVICES_INVALID
[[ "${compose_volumes[*]}" == "crm_documents postgres_data" ]] \
  || n05_fail LEGACY_SWITCH_COMPOSE_VOLUMES_INVALID
printf 'N05_LEGACY_SWITCH_PREFLIGHT_PASS|current=%s|target=%s|volumes=external-certified|network=external-certified|compose_version=%s\n' \
  "$CURRENT_APP_IMAGE" "$APP_IMAGE" "$compose_version"

if [[ "$ACTION" == "preflight" ]]; then
  trap - EXIT
  printf 'N05_LEGACY_SWITCH_READY|production_mutation=none\n'
  exit 0
fi

[[ "${CONFIRM_PRODUCTION_APP_SWITCH:-}" == "FAI_CRM_N05_PRODUCTION_APP_SWITCH_V1" ]] \
  || n05_fail PRODUCTION_APP_SWITCH_CONFIRMATION_MISMATCH
SWITCH_LOG="$(mktemp /tmp/fai-crm-n05-legacy-switch.XXXXXX.log)"
printf 'N05_LEGACY_SWITCH_BEGIN|from=%s|to=%s|postgres_action=none|volume_action=external-reuse|network_action=external-reuse\n' \
  "$CURRENT_APP_IMAGE" "$APP_IMAGE"
if ! compose_legacy --progress plain up -d --no-deps --no-build --force-recreate app \
  </dev/null >"$SWITCH_LOG" 2>&1; then
  tail -n 120 "$SWITCH_LOG" >&2
  n05_fail LEGACY_SWITCH_COMPOSE_FAILED
fi
if grep -Eiq 'recreate.*data will be lost|data will be lost.*recreate' "$SWITCH_LOG"; then
  tail -n 120 "$SWITCH_LOG" >&2
  n05_fail LEGACY_SWITCH_DESTRUCTIVE_PROMPT_DETECTED
fi
tail -n 120 "$SWITCH_LOG"
trap - EXIT
cleanup_switch_log
printf 'N05_LEGACY_SWITCH_COMMAND_PASS|target=%s|volume_recreation=none|network_recreation=none\n' "$APP_IMAGE"
