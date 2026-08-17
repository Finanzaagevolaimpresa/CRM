#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

: "${STAGING_EXPECT_ABSENT:?set STAGING_EXPECT_ABSENT=true for a separately authorized initial creation}"
[[ "$STAGING_EXPECT_ABSENT" == "true" ]] || n05_fail STAGING_PREFLIGHT_MODE_INVALID
n05_require_command docker
n05_assert_environment_identity staging
n05_assert_staging_env_file

compose_environment=(
  "COMPOSE_PROJECT_NAME=$(n05_env_value COMPOSE_PROJECT_NAME "$ENV_FILE")"
  "SECURITY_HEADERS_MODE=$(n05_env_value SECURITY_HEADERS_MODE "$ENV_FILE")"
  "SOURCE_COMMIT=$(n05_env_value SOURCE_COMMIT "$ENV_FILE")"
  "SOURCE_TREE=$(n05_env_value SOURCE_TREE "$ENV_FILE")"
  "APP_IMAGE=$(n05_env_value APP_IMAGE "$ENV_FILE")"
  "APP_ENV_FILE=$(n05_env_value APP_ENV_FILE "$ENV_FILE")"
  "DATABASE_URL=$(n05_env_value DATABASE_URL "$ENV_FILE")"
  "APP_PORT=$(n05_env_value APP_PORT "$ENV_FILE")"
  "POSTGRES_DB=$(n05_env_value POSTGRES_DB "$ENV_FILE")"
  "POSTGRES_USER=$(n05_env_value POSTGRES_USER "$ENV_FILE")"
  "POSTGRES_PASSWORD=$(n05_env_value POSTGRES_PASSWORD "$ENV_FILE")"
)

compose() {
  env "${compose_environment[@]}" \
    docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose config --quiet
mapfile -t services < <(compose config --services | LC_ALL=C sort)
[[ "${services[*]}" == "app postgres" ]] || n05_fail STAGING_COMPOSE_SERVICES_INVALID
mapfile -t volumes < <(compose config --volumes | LC_ALL=C sort)
[[ "$(printf '%s\n' "${volumes[@]}")" == $'staging_documents\nstaging_postgres_data' ]] \
  || n05_fail STAGING_COMPOSE_VOLUMES_INVALID
compose config --images | grep -Fxq "$APP_IMAGE" || n05_fail STAGING_COMPOSE_IMAGE_MISMATCH
n05_assert_project_absent "$COMPOSE_PROJECT_NAME"

printf 'N05_STAGING_PREFLIGHT_PASS|project=%s|mutation=none\n' "$COMPOSE_PROJECT_NAME"
