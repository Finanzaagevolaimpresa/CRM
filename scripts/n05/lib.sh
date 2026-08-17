#!/usr/bin/env bash

# Shared N05 release-safety primitives. Callers must enable strict mode.

N05_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
N05_REPO_ROOT="$(cd "$N05_LIB_DIR/../.." && pwd)"

n05_fail() {
  local code="${1:-UNSPECIFIED}"
  printf 'N05_FAILED|code=%s\n' "$code" >&2
  exit 1
}

n05_require_command() {
  command -v "$1" >/dev/null 2>&1 || n05_fail "MISSING_COMMAND_$1"
}

n05_assert_safe_token() {
  local value="${1:-}" label="${2:-TOKEN}"
  [[ -n "$value" && ${#value} -le 160 && "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.:@-]*$ ]] \
    || n05_fail "INVALID_${label}"
}

n05_assert_sha256() {
  local value="${1:-}" label="${2:-SHA256}"
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || n05_fail "INVALID_${label}"
}

n05_assert_git_oid() {
  local value="${1:-}" label="${2:-GIT_OID}"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || n05_fail "INVALID_${label}"
}

n05_realpath() {
  realpath -m -- "$1"
}

n05_env_value() {
  local key="$1" file="$2" value
  local -a matches=()
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || n05_fail ENV_KEY_INVALID
  mapfile -t matches < <(awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { print }
  ' "$file")
  [[ "${#matches[@]}" -eq 1 ]] || n05_fail "ENV_${key}_COUNT_INVALID"
  value="${matches[0]#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ ${#value} -ge 2 && (( "${value:0:1}" == '"' && "${value: -1}" == '"' ) || ( "${value:0:1}" == "'" && "${value: -1}" == "'" )) ]]; then
    value="${value:1:${#value}-2}"
  fi
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || n05_fail "ENV_${key}_VALUE_INVALID"
  printf '%s' "$value"
}

n05_run_with_env_file() {
  local file="$1" key value
  shift
  local -a environment=()
  local -A seen=()
  [[ -f "$file" && ! -L "$file" ]] || n05_fail ENV_FILE_NOT_REGULAR
  [[ "$#" -gt 0 ]] || n05_fail ENV_COMMAND_MISSING
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" ]] && continue
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || n05_fail ENV_FILE_LINE_INVALID
    [[ -z "${seen[$key]+present}" ]] || n05_fail "ENV_${key}_DUPLICATE"
    [[ "$value" != *$'\r'* && "$value" != *$'\n'* ]] || n05_fail "ENV_${key}_VALUE_INVALID"
    seen["$key"]=1
    environment+=("$key=$value")
  done < "$file"
  [[ "${#environment[@]}" -gt 0 ]] || n05_fail ENV_FILE_EMPTY
  env "${environment[@]}" "$@"
}

n05_assert_staging_env_file() {
  : "${ENV_FILE:?ENV_FILE is required}"
  : "${EXPECTED_DATABASE_NAME:?EXPECTED_DATABASE_NAME is required}"
  : "${EXPECTED_DATABASE_USER:?EXPECTED_DATABASE_USER is required}"
  : "${EXPECTED_SOURCE_COMMIT:?EXPECTED_SOURCE_COMMIT is required}"
  : "${EXPECTED_SOURCE_TREE:?EXPECTED_SOURCE_TREE is required}"
  local env_path database_url auth_secret postgres_password app_env_file app_port
  env_path="$(n05_realpath "$ENV_FILE")"
  [[ -f "$env_path" && ! -L "$env_path" ]] || n05_fail STAGING_ENV_NOT_REGULAR

  [[ "$(n05_env_value FAI_ENVIRONMENT "$env_path")" == "staging" ]] || n05_fail STAGING_ENVIRONMENT_VALUE_MISMATCH
  [[ "$(n05_env_value FAI_ENVIRONMENT_SENTINEL "$env_path")" == "FAI_CRM_STAGING_ISOLATED_V1" ]] || n05_fail STAGING_ENV_SENTINEL_VALUE_MISMATCH
  [[ "$(n05_env_value APP_ENV "$env_path")" == "staging" ]] || n05_fail STAGING_APP_ENV_VALUE_MISMATCH
  [[ "$(n05_env_value NODE_ENV "$env_path")" == "production" ]] || n05_fail STAGING_NODE_ENV_VALUE_MISMATCH
  [[ "$(n05_env_value COMPOSE_PROJECT_NAME "$env_path")" == "$COMPOSE_PROJECT_NAME" ]] || n05_fail STAGING_ENV_PROJECT_VALUE_MISMATCH
  [[ "$(n05_env_value APP_ORIGIN "$env_path")" == "$APP_ORIGIN" ]] || n05_fail STAGING_ENV_ORIGIN_VALUE_MISMATCH
  [[ "$APP_ORIGIN" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{2,5})?$ ]] || n05_fail STAGING_ORIGIN_INVALID
  [[ "$(n05_env_value NEXT_PUBLIC_APP_URL "$env_path")" == "$APP_ORIGIN" ]] || n05_fail STAGING_PUBLIC_URL_MISMATCH
  [[ "$(n05_env_value APP_IMAGE "$env_path")" == "$APP_IMAGE" ]] || n05_fail STAGING_ENV_IMAGE_VALUE_MISMATCH
  n05_assert_git_oid "$EXPECTED_SOURCE_COMMIT" EXPECTED_SOURCE_COMMIT
  n05_assert_git_oid "$EXPECTED_SOURCE_TREE" EXPECTED_SOURCE_TREE
  [[ "$(n05_env_value SOURCE_COMMIT "$env_path")" == "$EXPECTED_SOURCE_COMMIT" ]] || n05_fail STAGING_ENV_SOURCE_COMMIT_MISMATCH
  [[ "$(n05_env_value SOURCE_TREE "$env_path")" == "$EXPECTED_SOURCE_TREE" ]] || n05_fail STAGING_ENV_SOURCE_TREE_MISMATCH
  [[ "$APP_IMAGE" == "fai-crm:staging-$EXPECTED_SOURCE_COMMIT" ]] || n05_fail STAGING_IMAGE_TAG_NOT_COMMIT_BOUND
  [[ "$(n05_env_value POSTGRES_DB "$env_path")" == "$EXPECTED_DATABASE_NAME" ]] || n05_fail STAGING_ENV_DATABASE_VALUE_MISMATCH
  [[ "$(n05_env_value POSTGRES_USER "$env_path")" == "$EXPECTED_DATABASE_USER" ]] || n05_fail STAGING_ENV_DATABASE_USER_VALUE_MISMATCH
  [[ "$EXPECTED_DATABASE_NAME" =~ ^[a-z][a-z0-9_]{2,62}$ ]] || n05_fail STAGING_DATABASE_NAME_INVALID
  [[ "$EXPECTED_DATABASE_USER" =~ ^[a-z][a-z0-9_]{2,62}$ ]] || n05_fail STAGING_DATABASE_USER_INVALID

  app_env_file="$(n05_env_value APP_ENV_FILE "$env_path")"
  [[ "$(n05_realpath "$app_env_file")" == "$env_path" ]] || n05_fail STAGING_APP_ENV_FILE_MISMATCH
  postgres_password="$(n05_env_value POSTGRES_PASSWORD "$env_path")"
  [[ "$postgres_password" =~ ^[A-Za-z0-9._~-]{16,128}$ ]] || n05_fail STAGING_DATABASE_PASSWORD_INVALID
  database_url="$(n05_env_value DATABASE_URL "$env_path")"
  [[ "$database_url" == "postgresql://$EXPECTED_DATABASE_USER:$postgres_password@postgres:5432/$EXPECTED_DATABASE_NAME?schema=public" ]] \
    || n05_fail STAGING_DATABASE_URL_NOT_ISOLATED
  n05_assert_not_production_reference "$database_url" DATABASE_URL
  [[ "$APP_ORIGIN" != *'.invalid'* && "$APP_ORIGIN" != *'<'* ]] || n05_fail STAGING_ORIGIN_PLACEHOLDER
  app_port="$(n05_env_value APP_PORT "$env_path")"
  [[ "$app_port" =~ ^[0-9]{4,5}$ && "$app_port" -ge 1024 && "$app_port" -le 65535 && "$app_port" != "3000" ]] \
    || n05_fail STAGING_APP_PORT_INVALID

  auth_secret="$(n05_env_value AUTH_SECRET "$env_path")"
  [[ "$auth_secret" =~ ^[A-Za-z0-9._~+/=-]{32,256}$ && ${#postgres_password} -ge 16 && "$postgres_password" != *'<'* ]] \
    || n05_fail STAGING_SECRET_PLACEHOLDER_OR_WEAK
  [[ "$auth_secret" != "$postgres_password" ]] || n05_fail STAGING_SECRET_REUSE
  [[ "$(n05_env_value AUTH_COOKIE_NAME "$env_path")" =~ ^[A-Za-z0-9_]*staging[A-Za-z0-9_]*$ ]] || n05_fail STAGING_COOKIE_NOT_ISOLATED
  [[ "$(n05_env_value STORAGE_PROVIDER "$env_path")" == "local" ]] || n05_fail STAGING_STORAGE_PROVIDER_MISMATCH
  [[ "$(n05_env_value LOCAL_DOCUMENT_STORAGE_ROOT "$env_path")" == "/var/lib/fai-crm/documents" ]] \
    || n05_fail STAGING_DOCUMENT_ROOT_MISMATCH

  local key expected
  for key in FEATURE_INTEGRATIONS_ENABLED FEATURE_CUSTOMER_PORTAL_ENABLED FEATURE_PAYMENTS_ENABLED \
    FEATURE_AI_WORKER_ENABLED FEATURE_AI_DISPATCH_ENABLED FEATURE_AI_EGRESS_ENABLED AI_EXTERNAL_PROVIDERS_ENABLED; do
    [[ "$(n05_env_value "$key" "$env_path")" == "false" ]] || n05_fail "STAGING_${key}_NOT_FALSE"
  done
  for key in AI_ALLOWED_MODELS AI_API_KEY PRIVILEGED_STEP_UP_KEY_VERSION PRIVILEGED_STEP_UP_SECRET WEBSITE_LEAD_WEBHOOK_SECRET; do
    [[ -z "$(n05_env_value "$key" "$env_path")" ]] || n05_fail "STAGING_${key}_NOT_EMPTY"
  done
  for key in INTERNAL_SESSION_MODE PRIVILEGED_ACCESS_MODE LOGIN_THROTTLE_MODE SECURITY_HEADERS_MODE AI_PROVIDER AI_ORCHESTRATOR_WORKER_ENABLED WEBSITE_LEAD_MODE; do
    case "$key" in
      INTERNAL_SESSION_MODE) expected=legacy ;;
      PRIVILEGED_ACCESS_MODE|LOGIN_THROTTLE_MODE|WEBSITE_LEAD_MODE) expected=disabled ;;
      SECURITY_HEADERS_MODE) expected=report-only ;;
      AI_PROVIDER) expected=mock ;;
      AI_ORCHESTRATOR_WORKER_ENABLED) expected=0 ;;
    esac
    [[ "$(n05_env_value "$key" "$env_path")" == "$expected" ]] || n05_fail "STAGING_${key}_MISMATCH"
  done
}

n05_assert_not_production_reference() {
  local value="${1:-}" label="${2:-REFERENCE}"
  case "$value" in
    '/opt/fai-crm'|'/opt/fai-crm/'*|*'/opt/fai-crm/'*|*'.env.production'*|*'desk.finanzaagevolaimpresa.it'*|*'fai-crm_postgres_data'*|*'fai-crm_crm_documents'*)
      n05_fail "PRODUCTION_REFERENCE_${label}"
      ;;
  esac
}

n05_assert_environment_identity() {
  local expected_environment="${1:?expected environment is required}"
  : "${FAI_ENVIRONMENT:?FAI_ENVIRONMENT is required}"
  : "${FAI_ENVIRONMENT_SENTINEL:?FAI_ENVIRONMENT_SENTINEL is required}"
  : "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
  : "${COMPOSE_FILE:?COMPOSE_FILE is required}"
  : "${ENV_FILE:?ENV_FILE is required}"
  : "${APP_ORIGIN:?APP_ORIGIN is required}"
  : "${APP_IMAGE:?APP_IMAGE is required}"

  [[ "$FAI_ENVIRONMENT" == "$expected_environment" ]] || n05_fail ENVIRONMENT_MISMATCH
  n05_assert_safe_token "$COMPOSE_PROJECT_NAME" COMPOSE_PROJECT_NAME
  n05_assert_safe_token "${APP_IMAGE//\//-}" APP_IMAGE

  local compose_path env_path compose_name env_name expected_compose_path
  compose_path="$(n05_realpath "$COMPOSE_FILE")"
  env_path="$(n05_realpath "$ENV_FILE")"
  compose_name="$(basename "$compose_path")"
  env_name="$(basename "$env_path")"

  [[ "$compose_path" != "/" && "$env_path" != "/" ]] || n05_fail ROOT_PATH_DENIED
  [[ -f "$compose_path" && ! -L "$compose_path" ]] || n05_fail COMPOSE_FILE_NOT_REGULAR
  [[ -f "$env_path" && ! -L "$env_path" ]] || n05_fail ENV_FILE_NOT_REGULAR

  case "$expected_environment" in
    production)
      expected_compose_path="$(n05_realpath "$N05_REPO_ROOT/docker-compose.prod.example.yml")"
      [[ "$compose_path" == "$expected_compose_path" ]] || n05_fail PRODUCTION_COMPOSE_PATH_MISMATCH
      [[ "$FAI_ENVIRONMENT_SENTINEL" == "FAI_CRM_PRODUCTION_V1" ]] || n05_fail PRODUCTION_SENTINEL_MISMATCH
      [[ "$COMPOSE_PROJECT_NAME" == "fai-crm" ]] || n05_fail PRODUCTION_PROJECT_MISMATCH
      [[ "$compose_name" == "docker-compose.prod.example.yml" ]] || n05_fail PRODUCTION_COMPOSE_MISMATCH
      [[ "$env_name" == ".env.production" ]] || n05_fail PRODUCTION_ENV_FILE_MISMATCH
      [[ "$env_path" == "$(n05_realpath "$N05_REPO_ROOT/.env.production")" ]] || n05_fail PRODUCTION_ENV_PATH_MISMATCH
      [[ "$APP_ORIGIN" == "https://desk.finanzaagevolaimpresa.it" ]] || n05_fail PRODUCTION_ORIGIN_MISMATCH
      [[ "$APP_IMAGE" =~ ^fai-crm:pr[0-9]+-[0-9a-f]{12}$ ]] || n05_fail PRODUCTION_IMAGE_NOT_IMMUTABLE
      ;;
    staging)
      expected_compose_path="$(n05_realpath "$N05_REPO_ROOT/docker-compose.staging.example.yml")"
      [[ "$compose_path" == "$expected_compose_path" ]] || n05_fail STAGING_COMPOSE_PATH_MISMATCH
      [[ "$FAI_ENVIRONMENT_SENTINEL" == "FAI_CRM_STAGING_ISOLATED_V1" ]] || n05_fail STAGING_SENTINEL_MISMATCH
      [[ "$COMPOSE_PROJECT_NAME" =~ ^fai-crm-staging-[a-z0-9][a-z0-9-]{2,80}$ ]] || n05_fail STAGING_PROJECT_MISMATCH
      [[ "$compose_name" == "docker-compose.staging.example.yml" ]] || n05_fail STAGING_COMPOSE_MISMATCH
      [[ "$env_name" == ".env.staging" ]] || n05_fail STAGING_ENV_FILE_MISMATCH
      [[ "$APP_ORIGIN" =~ ^https:// ]] || n05_fail STAGING_HTTPS_REQUIRED
      n05_assert_not_production_reference "$compose_path" COMPOSE_FILE
      n05_assert_not_production_reference "$env_path" ENV_FILE
      n05_assert_not_production_reference "$APP_ORIGIN" APP_ORIGIN
      [[ ! "$APP_IMAGE" =~ ^fai-crm:pr ]] || n05_fail STAGING_PRODUCTION_IMAGE_TAG_DENIED
      ;;
    restore-source)
      expected_compose_path="$(n05_realpath "$N05_REPO_ROOT/docker-compose.restore-drill.yml")"
      [[ "$compose_path" == "$expected_compose_path" ]] || n05_fail RESTORE_COMPOSE_PATH_MISMATCH
      [[ "$FAI_ENVIRONMENT_SENTINEL" == "FAI_CRM_N05_RESTORE_SOURCE_V1" ]] || n05_fail RESTORE_SOURCE_SENTINEL_MISMATCH
      [[ "$COMPOSE_PROJECT_NAME" =~ ^fai-crm-restore-[a-z0-9][a-z0-9-]{2,80}-source$ ]] || n05_fail RESTORE_SOURCE_PROJECT_MISMATCH
      [[ "$compose_name" == "docker-compose.restore-drill.yml" ]] || n05_fail RESTORE_COMPOSE_MISMATCH
      [[ "$APP_ORIGIN" == "http://app:3000" ]] || n05_fail RESTORE_ORIGIN_MISMATCH
      n05_assert_not_production_reference "$compose_path" COMPOSE_FILE
      n05_assert_not_production_reference "$env_path" ENV_FILE
      n05_assert_not_production_reference "$APP_IMAGE" APP_IMAGE
      ;;
    restore-target)
      expected_compose_path="$(n05_realpath "$N05_REPO_ROOT/docker-compose.restore-drill.yml")"
      [[ "$compose_path" == "$expected_compose_path" ]] || n05_fail RESTORE_COMPOSE_PATH_MISMATCH
      [[ "$FAI_ENVIRONMENT_SENTINEL" == "FAI_CRM_N05_RESTORE_TARGET_V1" ]] || n05_fail RESTORE_TARGET_SENTINEL_MISMATCH
      [[ "$COMPOSE_PROJECT_NAME" =~ ^fai-crm-restore-[a-z0-9][a-z0-9-]{2,80}-target$ ]] || n05_fail RESTORE_TARGET_PROJECT_MISMATCH
      [[ "$compose_name" == "docker-compose.restore-drill.yml" ]] || n05_fail RESTORE_COMPOSE_MISMATCH
      [[ "$APP_ORIGIN" == "http://app:3000" ]] || n05_fail RESTORE_ORIGIN_MISMATCH
      n05_assert_not_production_reference "$compose_path" COMPOSE_FILE
      n05_assert_not_production_reference "$env_path" ENV_FILE
      n05_assert_not_production_reference "$APP_IMAGE" APP_IMAGE
      ;;
    *)
      n05_fail UNKNOWN_ENVIRONMENT
      ;;
  esac
}

n05_normalize_docker_label() {
  local value="${1:-}"
  [[ "$value" == "<no value>" ]] && value=""
  printf '%s' "$value"
}

n05_classify_resource_label_pair() {
  local mode="${1:?resource provenance mode is required}"
  local environment_label sentinel_label
  environment_label="$(n05_normalize_docker_label "${2:-}")"
  sentinel_label="$(n05_normalize_docker_label "${3:-}")"
  : "${FAI_ENVIRONMENT:?FAI_ENVIRONMENT is required}"
  : "${FAI_ENVIRONMENT_SENTINEL:?FAI_ENVIRONMENT_SENTINEL is required}"

  case "$mode" in
    n05-labels)
      [[ "$environment_label" == "$FAI_ENVIRONMENT" ]] || n05_fail RESOURCE_ENVIRONMENT_LABEL_MISMATCH
      [[ "$sentinel_label" == "$FAI_ENVIRONMENT_SENTINEL" ]] || n05_fail RESOURCE_SENTINEL_LABEL_MISMATCH
      printf 'n05-labeled'
      ;;
    authorized-legacy-compose-identity)
      [[ "$FAI_ENVIRONMENT" == "production" ]] || n05_fail LEGACY_RESOURCE_BRIDGE_PRODUCTION_ONLY
      if [[ -z "$environment_label" && -z "$sentinel_label" ]]; then
        printf 'legacy-unlabeled'
      else
        [[ "$environment_label" == "$FAI_ENVIRONMENT" ]] || n05_fail LEGACY_RESOURCE_ENVIRONMENT_LABEL_PARTIAL_OR_MISMATCHED
        [[ "$sentinel_label" == "$FAI_ENVIRONMENT_SENTINEL" ]] || n05_fail LEGACY_RESOURCE_SENTINEL_LABEL_PARTIAL_OR_MISMATCHED
        printf 'n05-labeled'
      fi
      ;;
    *) n05_fail BACKUP_RESOURCE_PROVENANCE_MODE_INVALID ;;
  esac
}

n05_assert_authorized_legacy_compose_resources() {
  local postgres_id="${1:?postgres container id is required}"
  local state app_documents_source postgres_data_source network_name resource
  local legacy_unlabeled_resources=0
  local -a all_project_container_ids=() all_postgres_ids=() app_ids=() project_volumes=() project_networks=() sorted_volumes=()

  [[ "${BACKUP_RESOURCE_PROVENANCE:-}" == "authorized-legacy-compose-identity" ]] \
    || n05_fail LEGACY_RESOURCE_BRIDGE_MODE_REQUIRED
  [[ "${CONFIRM_LEGACY_RESOURCE_IDENTITY:-}" == "FAI_CRM_N05_LEGACY_RESOURCE_BRIDGE_V1" ]] \
    || n05_fail LEGACY_RESOURCE_BRIDGE_CONFIRMATION_MISMATCH
  [[ "${FAI_ENVIRONMENT:-}" == "production" ]] || n05_fail LEGACY_RESOURCE_BRIDGE_PRODUCTION_ONLY
  [[ "${FAI_ENVIRONMENT_SENTINEL:-}" == "FAI_CRM_PRODUCTION_V1" ]] \
    || n05_fail LEGACY_RESOURCE_BRIDGE_SENTINEL_MISMATCH
  [[ "${COMPOSE_PROJECT_NAME:-}" == "fai-crm" ]] || n05_fail LEGACY_RESOURCE_BRIDGE_PROJECT_MISMATCH
  [[ "${APP_IMAGE:-}" =~ ^fai-crm:pr[0-9]+-[0-9a-f]{12}$ ]] || n05_fail LEGACY_APP_IMAGE_TAG_INVALID
  [[ "${EXPECTED_APP_IMAGE_ID:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || n05_fail LEGACY_APP_IMAGE_ID_INVALID

  classify_legacy_pair() {
    state="$(n05_classify_resource_label_pair "$BACKUP_RESOURCE_PROVENANCE" "$1" "$2")"
    [[ "$state" != "legacy-unlabeled" ]] || legacy_unlabeled_resources=$((legacy_unlabeled_resources + 1))
  }

  mapfile -t all_project_container_ids < <(docker ps -aq --no-trunc --filter 'label=com.docker.compose.project=fai-crm')
  mapfile -t all_postgres_ids < <(docker ps -aq --no-trunc \
    --filter 'label=com.docker.compose.project=fai-crm' \
    --filter 'label=com.docker.compose.service=postgres')
  mapfile -t app_ids < <(docker ps -aq --no-trunc \
    --filter 'label=com.docker.compose.project=fai-crm' \
    --filter 'label=com.docker.compose.service=app')
  [[ "${#all_project_container_ids[@]}" -eq 2 ]] || n05_fail LEGACY_PROJECT_CONTAINER_COUNT_MISMATCH
  [[ "${#all_postgres_ids[@]}" -eq 1 && "${all_postgres_ids[0]}" == "$postgres_id" ]] \
    || n05_fail LEGACY_POSTGRES_CONTAINER_IDENTITY_MISMATCH
  [[ "${#app_ids[@]}" -eq 1 && -n "${app_ids[0]}" ]] || n05_fail LEGACY_APP_CONTAINER_NOT_EXACTLY_ONE
  [[ -z "$(docker ps -q \
    --filter 'label=com.docker.compose.project=fai-crm' \
    --filter 'label=com.docker.compose.service=app')" ]] || n05_fail APPLICATION_NOT_QUIESCED

  [[ "$(docker inspect -f '{{.Name}}' "${app_ids[0]}")" == "/fai-crm-app-1" ]] \
    || n05_fail LEGACY_APP_CONTAINER_NAME_MISMATCH
  [[ "$(docker inspect -f '{{.Name}}' "$postgres_id")" == "/fai-crm-postgres-1" ]] \
    || n05_fail LEGACY_POSTGRES_CONTAINER_NAME_MISMATCH
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "${app_ids[0]}")" == "fai-crm" ]] \
    || n05_fail LEGACY_APP_PROJECT_LABEL_MISMATCH
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "${app_ids[0]}")" == "app" ]] \
    || n05_fail LEGACY_APP_SERVICE_LABEL_MISMATCH
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$postgres_id")" == "fai-crm" ]] \
    || n05_fail LEGACY_POSTGRES_PROJECT_LABEL_MISMATCH
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$postgres_id")" == "postgres" ]] \
    || n05_fail LEGACY_POSTGRES_SERVICE_LABEL_MISMATCH
  [[ "$(docker inspect -f '{{.Config.Image}}' "${app_ids[0]}")" == "$APP_IMAGE" ]] \
    || n05_fail LEGACY_APP_CONTAINER_IMAGE_TAG_MISMATCH
  [[ "$(docker inspect -f '{{.Image}}' "${app_ids[0]}")" == "$EXPECTED_APP_IMAGE_ID" ]] \
    || n05_fail LEGACY_APP_CONTAINER_IMAGE_ID_MISMATCH
  [[ "$(docker inspect -f '{{.Config.Image}}' "$postgres_id")" == "${POSTGRES_IMAGE:-postgres:16-alpine}" ]] \
    || n05_fail LEGACY_POSTGRES_IMAGE_MISMATCH

  app_documents_source="$(docker inspect -f '{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/var/lib/fai-crm/documents")}}{{.Name}}{{end}}{{end}}' "${app_ids[0]}")"
  postgres_data_source="$(docker inspect -f '{{range .Mounts}}{{if and (eq .Type "volume") (eq .Destination "/var/lib/postgresql/data")}}{{.Name}}{{end}}{{end}}' "$postgres_id")"
  [[ "$app_documents_source" == "fai-crm_crm_documents" ]] || n05_fail LEGACY_APP_DOCUMENTS_MOUNT_MISMATCH
  [[ "$postgres_data_source" == "fai-crm_postgres_data" ]] || n05_fail LEGACY_POSTGRES_DATA_MOUNT_MISMATCH

  classify_legacy_pair \
    "$(docker inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.environment"}}' "${app_ids[0]}")" \
    "$(docker inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.sentinel"}}' "${app_ids[0]}")"
  classify_legacy_pair \
    "$(docker inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.environment"}}' "$postgres_id")" \
    "$(docker inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.sentinel"}}' "$postgres_id")"

  mapfile -t project_volumes < <(docker volume ls -q --filter 'label=com.docker.compose.project=fai-crm')
  [[ "${#project_volumes[@]}" -eq 2 ]] || n05_fail LEGACY_PROJECT_VOLUME_COUNT_MISMATCH
  mapfile -t sorted_volumes < <(printf '%s\n' "${project_volumes[@]}" | LC_ALL=C sort)
  [[ "${sorted_volumes[*]}" == "fai-crm_crm_documents fai-crm_postgres_data" ]] \
    || n05_fail LEGACY_VOLUME_NAMES_MISMATCH
  for resource in "${project_volumes[@]}"; do
    [[ "$(docker volume inspect -f '{{.Driver}}' "$resource")" == "local" ]] || n05_fail LEGACY_VOLUME_DRIVER_MISMATCH
    [[ "$(docker volume inspect -f '{{.Scope}}' "$resource")" == "local" ]] || n05_fail LEGACY_VOLUME_SCOPE_MISMATCH
    [[ "$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$resource")" == "fai-crm" ]] \
      || n05_fail LEGACY_VOLUME_PROJECT_LABEL_MISMATCH
    case "$resource" in
      fai-crm_crm_documents)
        [[ "$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' "$resource")" == "crm_documents" ]] \
          || n05_fail LEGACY_DOCUMENTS_LOGICAL_LABEL_MISMATCH
        ;;
      fai-crm_postgres_data)
        [[ "$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' "$resource")" == "postgres_data" ]] \
          || n05_fail LEGACY_POSTGRES_LOGICAL_LABEL_MISMATCH
        ;;
      *) n05_fail LEGACY_VOLUME_NAME_DENIED ;;
    esac
    classify_legacy_pair \
      "$(docker volume inspect -f '{{index .Labels "it.finanzaagevolaimpresa.environment"}}' "$resource")" \
      "$(docker volume inspect -f '{{index .Labels "it.finanzaagevolaimpresa.sentinel"}}' "$resource")"
  done

  mapfile -t project_networks < <(docker network ls -q --filter 'label=com.docker.compose.project=fai-crm')
  [[ "${#project_networks[@]}" -eq 1 && -n "${project_networks[0]}" ]] \
    || n05_fail LEGACY_PROJECT_NETWORK_COUNT_MISMATCH
  network_name="$(docker network inspect -f '{{.Name}}' "${project_networks[0]}")"
  [[ "$network_name" == "fai-crm_default" ]] || n05_fail LEGACY_NETWORK_NAME_MISMATCH
  [[ "$(docker network inspect -f '{{.Driver}}' "${project_networks[0]}")" == "bridge" ]] \
    || n05_fail LEGACY_NETWORK_DRIVER_MISMATCH
  [[ "$(docker network inspect -f '{{.Scope}}' "${project_networks[0]}")" == "local" ]] \
    || n05_fail LEGACY_NETWORK_SCOPE_MISMATCH
  [[ "$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' "${project_networks[0]}")" == "fai-crm" ]] \
    || n05_fail LEGACY_NETWORK_PROJECT_LABEL_MISMATCH
  [[ "$(docker network inspect -f '{{index .Labels "com.docker.compose.network"}}' "${project_networks[0]}")" == "default" ]] \
    || n05_fail LEGACY_NETWORK_LOGICAL_LABEL_MISMATCH
  classify_legacy_pair \
    "$(docker network inspect -f '{{index .Labels "it.finanzaagevolaimpresa.environment"}}' "${project_networks[0]}")" \
    "$(docker network inspect -f '{{index .Labels "it.finanzaagevolaimpresa.sentinel"}}' "${project_networks[0]}")"

  (( legacy_unlabeled_resources > 0 )) || n05_fail LEGACY_RESOURCE_BRIDGE_NOT_REQUIRED
  printf '%s' "$legacy_unlabeled_resources"
}

n05_project_resource_ids() {
  local project="$1" containers networks volumes
  containers="$(docker ps -aq --filter "label=com.docker.compose.project=$project")" || return 1
  networks="$(docker network ls -q --filter "label=com.docker.compose.project=$project")" || return 1
  volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" || return 1
  printf '%s\n%s\n%s\n' "$containers" "$networks" "$volumes"
}

n05_assert_project_absent() {
  local project="$1" count resource_ids
  resource_ids="$(n05_project_resource_ids "$project")" || n05_fail DOCKER_PROJECT_INSPECTION_FAILED
  count="$(printf '%s\n' "$resource_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
  [[ "$count" == "0" ]] || n05_fail PROJECT_ALREADY_EXISTS
}

n05_cleanup_restore_project() {
  local project="$1" resource remaining
  [[ "$project" =~ ^fai-crm-restore-[a-z0-9][a-z0-9-]{2,80}-(source|target)$ ]] \
    || n05_fail CLEANUP_PROJECT_DENIED

  while IFS= read -r resource; do
    [[ -n "$resource" ]] && docker rm -f "$resource" >/dev/null 2>&1 || true
  done < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
  while IFS= read -r resource; do
    [[ -n "$resource" ]] && docker network rm "$resource" >/dev/null 2>&1 || true
  done < <(docker network ls -q --filter "label=com.docker.compose.project=$project")
  while IFS= read -r resource; do
    [[ -n "$resource" ]] && docker volume rm "$resource" >/dev/null 2>&1 || true
  done < <(docker volume ls -q --filter "label=com.docker.compose.project=$project")
  remaining="$(n05_project_resource_ids "$project")" || return 1
  [[ -z "$(printf '%s\n' "$remaining" | sed '/^$/d')" ]]
}

n05_assert_archive_safe() {
  local archive="$1" entry line entry_count=0
  [[ -f "$archive" && ! -L "$archive" ]] || n05_fail DOCUMENT_ARCHIVE_NOT_REGULAR
  LC_ALL=C tar --quoting-style=escape -tzf "$archive" >/dev/null \
    || n05_fail DOCUMENT_ARCHIVE_INTEGRITY_INVALID
  LC_ALL=C tar --quoting-style=escape -tvzf "$archive" >/dev/null \
    || n05_fail DOCUMENT_ARCHIVE_INTEGRITY_INVALID

  while IFS= read -r entry; do
    entry_count=$((entry_count + 1))
    [[ $entry_count -le 20000 ]] || n05_fail DOCUMENT_ARCHIVE_TOO_MANY_ENTRIES
    [[ -n "$entry" && ${#entry} -le 512 ]] || n05_fail DOCUMENT_ARCHIVE_PATH_INVALID
    case "$entry" in
      /*|../*|*/../*|*/..|*'\\'*|*'//'*) n05_fail DOCUMENT_ARCHIVE_PATH_TRAVERSAL ;;
    esac
  done < <(LC_ALL=C tar --quoting-style=escape -tzf "$archive")
  [[ $entry_count -gt 0 ]] || n05_fail DOCUMENT_ARCHIVE_EMPTY

  while IFS= read -r line; do
    case "${line:0:1}" in
      -|d) ;;
      *) n05_fail DOCUMENT_ARCHIVE_SPECIAL_ENTRY ;;
    esac
  done < <(LC_ALL=C tar --quoting-style=escape -tvzf "$archive")
}

n05_remove_temp_tree() {
  local target="$1" resolved
  resolved="$(n05_realpath "$target")"
  [[ "$resolved" =~ ^/tmp/fai-crm-n05-[A-Za-z0-9._-]+$ ]] || n05_fail TEMP_CLEANUP_PATH_DENIED
  [[ -d "$resolved" && ! -L "$resolved" ]] || return 0
  find "$resolved" -depth -mindepth 1 -delete
  rmdir "$resolved"
}
