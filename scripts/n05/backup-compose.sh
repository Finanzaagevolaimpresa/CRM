#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

: "${BACKUP_ROOT:?BACKUP_ROOT is required and must already exist}"
: "${BACKUP_SET_ID:?BACKUP_SET_ID is required}"
: "${SOURCE_COMMIT:?SOURCE_COMMIT is required}"
: "${SOURCE_TREE:?SOURCE_TREE is required}"
: "${EXPECTED_APP_IMAGE_ID:?EXPECTED_APP_IMAGE_ID is required}"
: "${BACKUP_IMAGE_PROVENANCE:?BACKUP_IMAGE_PROVENANCE is required}"
: "${BACKUP_RESOURCE_PROVENANCE:?BACKUP_RESOURCE_PROVENANCE is required}"
: "${EXPECTED_DATABASE_NAME:?EXPECTED_DATABASE_NAME is required}"
: "${BACKUP_CONSISTENCY:?BACKUP_CONSISTENCY is required}"

n05_require_command docker
n05_require_command git
n05_require_command sha256sum
n05_require_command tar
n05_assert_environment_identity "$FAI_ENVIRONMENT"
n05_assert_safe_token "$BACKUP_SET_ID" BACKUP_SET_ID
n05_assert_git_oid "$SOURCE_COMMIT" SOURCE_COMMIT
n05_assert_git_oid "$SOURCE_TREE" SOURCE_TREE
[[ "$EXPECTED_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || n05_fail EXPECTED_APP_IMAGE_ID_INVALID
[[ "$(git -C "$N05_REPO_ROOT" rev-parse "$SOURCE_COMMIT^{tree}")" == "$SOURCE_TREE" ]] || n05_fail BACKUP_SOURCE_TREE_MISMATCH
n05_assert_safe_token "$EXPECTED_DATABASE_NAME" EXPECTED_DATABASE_NAME
[[ "$BACKUP_CONSISTENCY" == "application-quiesced" ]] || n05_fail BACKUP_NOT_QUIESCED
case "$BACKUP_RESOURCE_PROVENANCE" in
  n05-labels) ;;
  authorized-legacy-compose-identity)
    [[ "$FAI_ENVIRONMENT" == "production" ]] || n05_fail LEGACY_RESOURCE_BRIDGE_PRODUCTION_ONLY
    [[ "${CONFIRM_LEGACY_RESOURCE_IDENTITY:-}" == "FAI_CRM_N05_LEGACY_RESOURCE_BRIDGE_V1" ]] \
      || n05_fail LEGACY_RESOURCE_BRIDGE_CONFIRMATION_MISMATCH
    ;;
  *) n05_fail BACKUP_RESOURCE_PROVENANCE_MODE_INVALID ;;
esac

BACKUP_ROOT="$(n05_realpath "$BACKUP_ROOT")"
[[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" && "$BACKUP_ROOT" != "/" ]] || n05_fail BACKUP_ROOT_INVALID
[[ "$(stat -c '%a' "$BACKUP_ROOT")" == "700" ]] || n05_fail BACKUP_ROOT_PERMISSIONS

FINAL_DIR="$BACKUP_ROOT/$BACKUP_SET_ID"
PARTIAL_DIR="$BACKUP_ROOT/.partial-$BACKUP_SET_ID"
[[ ! -e "$FINAL_DIR" && ! -e "$PARTIAL_DIR" ]] || n05_fail BACKUP_SET_ALREADY_EXISTS
mkdir "$PARTIAL_DIR"
chmod 700 "$PARTIAL_DIR"

PARTIAL_ACTIVE=true
cleanup_partial() {
  set +e
  if [[ "$PARTIAL_ACTIVE" == true && -d "$PARTIAL_DIR" && ! -L "$PARTIAL_DIR" && "$(dirname "$PARTIAL_DIR")" == "$BACKUP_ROOT" ]]; then
    find "$PARTIAL_DIR" -depth -mindepth 1 -delete
    rmdir "$PARTIAL_DIR"
  fi
}
trap cleanup_partial EXIT

compose() {
  docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

printf 'N05_BACKUP_BEGIN|environment=%s|project=%s\n' "$FAI_ENVIRONMENT" "$COMPOSE_PROJECT_NAME"
compose config --quiet
mapfile -t services < <(compose config --services | LC_ALL=C sort)
[[ "${#services[@]}" -eq 2 && "${services[0]}" == "app" && "${services[1]}" == "postgres" ]] \
  || n05_fail BACKUP_COMPOSE_SERVICES_INVALID
mapfile -t compose_volumes < <(compose config --volumes | LC_ALL=C sort)
case "$FAI_ENVIRONMENT" in
  production)
    expected_volumes=$'crm_documents\npostgres_data'
    documents_logical_volume='crm_documents'
    ;;
  staging)
    expected_volumes=$'staging_documents\nstaging_postgres_data'
    documents_logical_volume='staging_documents'
    ;;
  restore-source)
    expected_volumes=$'restore_documents\nrestore_postgres_data'
    documents_logical_volume='restore_documents'
    ;;
  *) n05_fail BACKUP_ENVIRONMENT_NOT_SUPPORTED ;;
esac
[[ "$(printf '%s\n' "${compose_volumes[@]}")" == "$expected_volumes" ]] || n05_fail BACKUP_COMPOSE_VOLUMES_INVALID
compose config --images | grep -Fxq "$APP_IMAGE" || n05_fail BACKUP_COMPOSE_IMAGE_MISMATCH
app_image_id="$(docker image inspect -f '{{.Id}}' "$APP_IMAGE")"
app_image_commit="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$APP_IMAGE")"
app_image_tree="$(docker image inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}' "$APP_IMAGE")"
[[ "$app_image_commit" == "<no value>" ]] && app_image_commit=""
[[ "$app_image_tree" == "<no value>" ]] && app_image_tree=""
[[ "$app_image_id" == "$EXPECTED_APP_IMAGE_ID" ]] || n05_fail BACKUP_APP_IMAGE_ID_MISMATCH
case "$BACKUP_IMAGE_PROVENANCE" in
  oci-labels)
    [[ "$app_image_commit" == "$SOURCE_COMMIT" && "$app_image_tree" == "$SOURCE_TREE" ]] \
      || n05_fail BACKUP_APP_IMAGE_PROVENANCE_MISMATCH
    ;;
  authorized-legacy-image-id)
    [[ "$FAI_ENVIRONMENT" == "production" ]] || n05_fail LEGACY_IMAGE_PROVENANCE_PRODUCTION_ONLY
    [[ "$APP_IMAGE" == *"${SOURCE_COMMIT:0:12}" ]] || n05_fail LEGACY_IMAGE_TAG_SHA_MISMATCH
    [[ -z "$app_image_commit" && -z "$app_image_tree" ]] || n05_fail LEGACY_IMAGE_HAS_UNEXPECTED_PROVENANCE
    ;;
  *) n05_fail BACKUP_IMAGE_PROVENANCE_MODE_INVALID ;;
esac

mapfile -t postgres_ids < <(compose ps -q --status running postgres)
[[ "${#postgres_ids[@]}" -eq 1 && -n "${postgres_ids[0]}" ]] || n05_fail POSTGRES_NOT_EXACTLY_ONE_RUNNING
[[ -z "$(compose ps -q --status running app)" ]] || n05_fail APPLICATION_NOT_QUIESCED
if [[ "$BACKUP_RESOURCE_PROVENANCE" == "authorized-legacy-compose-identity" ]]; then
  legacy_unlabeled_resources="$(n05_assert_authorized_legacy_compose_resources "${postgres_ids[0]}")"
  [[ "$legacy_unlabeled_resources" =~ ^[1-5]$ ]] || n05_fail LEGACY_RESOURCE_COUNT_INVALID
else
  mapfile -t project_volumes < <(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
  [[ "${#project_volumes[@]}" -eq 2 ]] || n05_fail PROJECT_VOLUME_COUNT_MISMATCH
  mapfile -t project_networks < <(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
  [[ "${#project_networks[@]}" -eq 1 ]] || n05_fail PROJECT_NETWORK_COUNT_MISMATCH
  n05_classify_resource_label_pair "$BACKUP_RESOURCE_PROVENANCE" \
    "$(docker inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.environment"}}' "${postgres_ids[0]}")" \
    "$(docker inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.sentinel"}}' "${postgres_ids[0]}")" >/dev/null
  for volume_id in "${project_volumes[@]}"; do
    n05_classify_resource_label_pair "$BACKUP_RESOURCE_PROVENANCE" \
      "$(docker volume inspect -f '{{index .Labels "it.finanzaagevolaimpresa.environment"}}' "$volume_id")" \
      "$(docker volume inspect -f '{{index .Labels "it.finanzaagevolaimpresa.sentinel"}}' "$volume_id")" >/dev/null
  done
  n05_classify_resource_label_pair "$BACKUP_RESOURCE_PROVENANCE" \
    "$(docker network inspect -f '{{index .Labels "it.finanzaagevolaimpresa.environment"}}' "${project_networks[0]}")" \
    "$(docker network inspect -f '{{index .Labels "it.finanzaagevolaimpresa.sentinel"}}' "${project_networks[0]}")" >/dev/null
fi

actual_database_name="$(compose exec -T postgres sh -c 'printf %s "$POSTGRES_DB"')"
[[ "$actual_database_name" == "$EXPECTED_DATABASE_NAME" ]] || n05_fail DATABASE_NAME_MISMATCH

database_comment="$(compose exec -T postgres sh -c \
  'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "$1"' sh \
  "SELECT COALESCE(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()")"
if [[ "$FAI_ENVIRONMENT" != "production" ]]; then
  : "${EXPECTED_DATABASE_SENTINEL:?EXPECTED_DATABASE_SENTINEL is required outside production}"
  [[ "$database_comment" == "$EXPECTED_DATABASE_SENTINEL" ]] || n05_fail DATABASE_SENTINEL_MISMATCH
fi

migration_count="$(compose exec -T postgres sh -c \
  'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "$1"' sh \
  'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
[[ "$migration_count" == "${EXPECTED_MIGRATION_COUNT:-37}" ]] || n05_fail DATABASE_MIGRATION_COUNT_MISMATCH

DATABASE_FILE="postgres.dump"
DOCUMENTS_FILE="documents.tar.gz"
compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges' \
  > "$PARTIAL_DIR/$DATABASE_FILE"
chmod 600 "$PARTIAL_DIR/$DATABASE_FILE"
[[ -s "$PARTIAL_DIR/$DATABASE_FILE" ]] || n05_fail DATABASE_BACKUP_EMPTY
compose exec -T postgres pg_restore --list < "$PARTIAL_DIR/$DATABASE_FILE" >/dev/null

mapfile -t documents_volumes < <(docker volume ls -q \
  --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --filter "label=com.docker.compose.volume=$documents_logical_volume")
[[ "${#documents_volumes[@]}" -eq 1 && -n "${documents_volumes[0]}" ]] \
  || n05_fail DOCUMENTS_VOLUME_IDENTITY_MISMATCH
documents_volume="${documents_volumes[0]}"

docker run --rm --pull never \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges=true \
  --mount "type=volume,src=$documents_volume,dst=/var/lib/fai-crm/documents,readonly" \
  --env "FAI_ENVIRONMENT_SENTINEL=$FAI_ENVIRONMENT_SENTINEL" \
  --entrypoint sh \
  "$APP_IMAGE" -c '
  set -eu
  test "$FAI_ENVIRONMENT_SENTINEL" = "$1"
  test -d "$2"
  exec tar -czf - -C "$2" -- .
' sh "$FAI_ENVIRONMENT_SENTINEL" /var/lib/fai-crm/documents > "$PARTIAL_DIR/$DOCUMENTS_FILE"
chmod 600 "$PARTIAL_DIR/$DOCUMENTS_FILE"
n05_assert_archive_safe "$PARTIAL_DIR/$DOCUMENTS_FILE"

created_at="$(date -u +%Y%m%dT%H%M%SZ)"
{
  printf 'schema=FAI_CRM_N05_BACKUP_V1\n'
  printf 'environment=%s\n' "$FAI_ENVIRONMENT"
  printf 'environment_sentinel=%s\n' "$FAI_ENVIRONMENT_SENTINEL"
  printf 'compose_project=%s\n' "$COMPOSE_PROJECT_NAME"
  printf 'created_at=%s\n' "$created_at"
  printf 'consistency=application-quiesced\n'
  printf 'source_commit=%s\n' "$SOURCE_COMMIT"
  printf 'source_tree=%s\n' "$SOURCE_TREE"
  printf 'app_image_id=%s\n' "$app_image_id"
  printf 'image_provenance=%s\n' "$BACKUP_IMAGE_PROVENANCE"
  printf 'resource_provenance=%s\n' "$BACKUP_RESOURCE_PROVENANCE"
  printf 'migration_count=%s\n' "$migration_count"
  printf 'database_file=%s\n' "$DATABASE_FILE"
  printf 'documents_file=%s\n' "$DOCUMENTS_FILE"
} > "$PARTIAL_DIR/MANIFEST.txt"
chmod 600 "$PARTIAL_DIR/MANIFEST.txt"

(
  cd "$PARTIAL_DIR"
  sha256sum "$DATABASE_FILE" "$DOCUMENTS_FILE" > SHA256SUMS
  chmod 600 SHA256SUMS
)

EXPECTED_ENVIRONMENT="$FAI_ENVIRONMENT" \
EXPECTED_PROJECT="$COMPOSE_PROJECT_NAME" \
EXPECTED_SOURCE_COMMIT="$SOURCE_COMMIT" \
EXPECTED_SOURCE_TREE="$SOURCE_TREE" \
EXPECTED_APP_IMAGE_ID="$app_image_id" \
EXPECTED_IMAGE_PROVENANCE="$BACKUP_IMAGE_PROVENANCE" \
EXPECTED_RESOURCE_PROVENANCE="$BACKUP_RESOURCE_PROVENANCE" \
EXPECTED_MIGRATION_COUNT="$migration_count" \
  "$SCRIPT_DIR/verify-backup-manifest.sh" "$PARTIAL_DIR" >/dev/null

mv "$PARTIAL_DIR" "$FINAL_DIR"
PARTIAL_ACTIVE=false
printf 'N05_BACKUP_PASS|set=%s|migrations=%s\n' "$FINAL_DIR" "$migration_count"
