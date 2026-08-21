#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

n05_require_command docker
n05_require_command git
n05_require_command sha256sum
n05_require_command tar

SOURCE_COMMIT="${SOURCE_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
SOURCE_TREE="${SOURCE_TREE:-$(git -C "$REPO_ROOT" rev-parse HEAD^{tree})}"
ROLLBACK_COMMIT="${ROLLBACK_COMMIT:?ROLLBACK_COMMIT is required and must be the authorized N-1 commit}"
ROLLBACK_TREE="${ROLLBACK_TREE:?ROLLBACK_TREE is required}"
EXPECTED_MIGRATION_COUNT="${EXPECTED_MIGRATION_COUNT:-39}"
n05_assert_git_oid "$SOURCE_COMMIT" SOURCE_COMMIT
n05_assert_git_oid "$SOURCE_TREE" SOURCE_TREE
n05_assert_git_oid "$ROLLBACK_COMMIT" ROLLBACK_COMMIT
n05_assert_git_oid "$ROLLBACK_TREE" ROLLBACK_TREE
[[ "$(git -C "$REPO_ROOT" rev-parse "$SOURCE_COMMIT^{tree}")" == "$SOURCE_TREE" ]] || n05_fail SOURCE_TREE_MISMATCH
[[ "$(git -C "$REPO_ROOT" rev-parse "$ROLLBACK_COMMIT^{tree}")" == "$ROLLBACK_TREE" ]] || n05_fail ROLLBACK_TREE_MISMATCH
[[ "$EXPECTED_MIGRATION_COUNT" == "39" ]] || n05_fail RESTORE_DRILL_MIGRATION_COUNT_MUST_BE_39

raw_run_id="${N05_RUN_ID:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${BASHPID}}"
RUN_ID="$(printf '%s' "$raw_run_id" | tr '[:upper:]_.' '[:lower:]--' | tr -cd 'a-z0-9-' | cut -c1-64)"
[[ "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{2,63}$ ]] || n05_fail INVALID_RESTORE_RUN_ID

SOURCE_PROJECT="fai-crm-restore-$RUN_ID-source"
TARGET_PROJECT="fai-crm-restore-$RUN_ID-target"
CURRENT_IMAGE="fai-crm:n05-restore-$RUN_ID-${SOURCE_COMMIT:0:12}"
ROLLBACK_IMAGE="fai-crm:n05-rollback-$RUN_ID-${ROLLBACK_COMMIT:0:12}"
COMPOSE_FILE="$REPO_ROOT/docker-compose.restore-drill.yml"
WORK_ROOT="$(mktemp -d /tmp/fai-crm-n05-restore.XXXXXX)"
chmod 700 "$WORK_ROOT"
SOURCE_ENV_FILE="$WORK_ROOT/source.env"
TARGET_ENV_FILE="$WORK_ROOT/target.env"
BACKUP_ROOT="$WORK_ROOT/backups"
ROLLBACK_SOURCE="$WORK_ROOT/rollback-source"
mkdir "$BACKUP_ROOT" "$ROLLBACK_SOURCE"
chmod 700 "$BACKUP_ROOT" "$ROLLBACK_SOURCE"

CURRENT_IMAGE_CREATED=false
ROLLBACK_IMAGE_CREATED=false
SOURCE_CREATED=false
TARGET_CREATED=false

cleanup_resources() (
  set +e
  cleanup_failed=false
  if [[ "$SOURCE_CREATED" == true ]] && ! n05_cleanup_restore_project "$SOURCE_PROJECT"; then
    cleanup_failed=true
  fi
  if [[ "$TARGET_CREATED" == true ]] && ! n05_cleanup_restore_project "$TARGET_PROJECT"; then
    cleanup_failed=true
  fi
  [[ "$CURRENT_IMAGE_CREATED" == true ]] && docker image rm "$CURRENT_IMAGE" >/dev/null 2>&1 || true
  [[ "$ROLLBACK_IMAGE_CREATED" == true ]] && docker image rm "$ROLLBACK_IMAGE" >/dev/null 2>&1 || true
  if [[ "$CURRENT_IMAGE_CREATED" == true ]] && docker image inspect "$CURRENT_IMAGE" >/dev/null 2>&1; then
    cleanup_failed=true
  fi
  if [[ "$ROLLBACK_IMAGE_CREATED" == true ]] && docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    cleanup_failed=true
  fi
  if [[ -d "$WORK_ROOT" ]] && ! n05_remove_temp_tree "$WORK_ROOT"; then
    cleanup_failed=true
  fi
  [[ "$cleanup_failed" == false ]]
)

cleanup_on_exit() {
  local original_status=$?
  if ! cleanup_resources; then
    printf 'N05_FAILED|code=RESTORE_CLEANUP_INCOMPLETE\n' >&2
    exit 1
  fi
  exit "$original_status"
}
trap cleanup_on_exit EXIT

write_env_file() {
  local file="$1" environment="$2" sentinel="$3" project="$4" image="$5" db_name="$6" db_user="$7"
  local db_password="n05-synthetic-${RUN_ID}-password"
  {
    printf 'FAI_ENVIRONMENT=%s\n' "$environment"
    printf 'FAI_ENVIRONMENT_SENTINEL=%s\n' "$sentinel"
    printf 'COMPOSE_PROJECT_NAME=%s\n' "$project"
    printf 'APP_IMAGE=%s\n' "$image"
    printf 'APP_ENV_FILE=%s\n' "$file"
    printf 'APP_ORIGIN=http://app:3000\n'
    printf 'POSTGRES_DB=%s\n' "$db_name"
    printf 'POSTGRES_USER=%s\n' "$db_user"
    printf 'POSTGRES_PASSWORD=%s\n' "$db_password"
    printf 'DATABASE_URL=postgresql://%s:%s@postgres:5432/%s?schema=public\n' "$db_user" "$db_password" "$db_name"
    printf 'AUTH_SECRET=n05-synthetic-auth-secret-not-for-production-%s\n' "$RUN_ID"
    printf 'AUTH_COOKIE_NAME=fai_crm_n05_restore_session\n'
    printf 'INTERNAL_SESSION_MODE=legacy\n'
    printf 'PRIVILEGED_ACCESS_MODE=disabled\n'
    printf 'LOGIN_THROTTLE_MODE=disabled\n'
    printf 'LOGIN_THROTTLE_MAX_FAILURES=5\n'
    printf 'LOGIN_THROTTLE_WINDOW_SECONDS=900\n'
    printf 'LOGIN_THROTTLE_BLOCK_SECONDS=900\n'
    printf 'SECURITY_HEADERS_MODE=report-only\n'
    printf 'FEATURE_INTEGRATIONS_ENABLED=false\n'
    printf 'FEATURE_CUSTOMER_PORTAL_ENABLED=false\n'
    printf 'FEATURE_PAYMENTS_ENABLED=false\n'
    printf 'FEATURE_AI_WORKER_ENABLED=false\n'
    printf 'FEATURE_AI_DISPATCH_ENABLED=false\n'
    printf 'FEATURE_AI_EGRESS_ENABLED=false\n'
    printf 'STORAGE_PROVIDER=local\n'
    printf 'LOCAL_DOCUMENT_STORAGE_ROOT=/var/lib/fai-crm/documents\n'
    printf 'AI_PROVIDER=mock\n'
    printf 'AI_EXTERNAL_PROVIDERS_ENABLED=false\n'
    printf 'AI_ALLOWED_MODELS=\n'
    printf 'AI_ORCHESTRATOR_WORKER_ENABLED=0\n'
    printf 'AI_API_KEY=\n'
    printf 'PRIVILEGED_STEP_UP_KEY_VERSION=\n'
    printf 'PRIVILEGED_STEP_UP_SECRET=\n'
    printf 'SECURE_LEAD_GATEWAY_MODE=disabled\n'
    printf 'SECURE_LEAD_GATEWAY_KEYRING_FILE=\n'
  } > "$file"
  chmod 600 "$file"
}

guard_identity() (
  export FAI_ENVIRONMENT="$1"
  export FAI_ENVIRONMENT_SENTINEL="$2"
  export COMPOSE_PROJECT_NAME="$3"
  export COMPOSE_FILE
  export ENV_FILE="$4"
  export APP_ORIGIN=http://app:3000
  export APP_IMAGE="$5"
  n05_assert_environment_identity "$1"
)

compose_source() (
  n05_run_with_env_file "$SOURCE_ENV_FILE" \
    docker compose -p "$SOURCE_PROJECT" --env-file "$SOURCE_ENV_FILE" -f "$COMPOSE_FILE" "$@"
)

compose_target() (
  n05_run_with_env_file "$TARGET_ENV_FILE" \
    docker compose -p "$TARGET_PROJECT" --env-file "$TARGET_ENV_FILE" -f "$COMPOSE_FILE" "$@"
)

wait_for_postgres() {
  local compose_name="$1" database_user="$2" database_name="$3"
  [[ "$compose_name" == source || "$compose_name" == target ]] || n05_fail RESTORE_COMPOSE_NAME_INVALID
  for _ in $(seq 1 120); do
    if [[ "$compose_name" == source ]]; then
      compose_source exec -T postgres pg_isready -U "$database_user" -d "$database_name" >/dev/null 2>&1 && return 0
    else
      compose_target exec -T postgres pg_isready -U "$database_user" -d "$database_name" >/dev/null 2>&1 && return 0
    fi
    sleep 0.5
  done
  n05_fail RESTORE_POSTGRES_UNHEALTHY
}

wait_for_app() {
  local compose_name="$1" health_json="" container_id=""
  for _ in $(seq 1 120); do
    if [[ "$compose_name" == source ]]; then
      container_id="$(compose_source ps -q --status running app)"
      [[ -n "$container_id" ]] && health_json="$(compose_source exec -T app node -e \
        'fetch("http://127.0.0.1:3000/api/health").then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))' 2>/dev/null)" && break
    else
      container_id="$(compose_target ps -q --status running app)"
      [[ -n "$container_id" ]] && health_json="$(compose_target exec -T app node -e \
        'fetch("http://127.0.0.1:3000/api/health").then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))' 2>/dev/null)" && break
    fi
    sleep 0.5
  done
  [[ -n "$health_json" ]] || n05_fail RESTORED_APPLICATION_UNHEALTHY
  printf '%s' "$health_json" | node -e '
    const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8"));
    if(value.ok!==true || value.status!=="ok" || value.app!=="fai-crm" || value.database?.reachable!==true) process.exit(1);
  ' || n05_fail RESTORED_HEALTH_CONTRACT_INVALID
}

printf 'N05_RESTORE_DRILL_BEGIN|run=%s|source=%s|target=%s\n' "$RUN_ID" "$SOURCE_COMMIT" "$ROLLBACK_COMMIT"
n05_assert_project_absent "$SOURCE_PROJECT"
n05_assert_project_absent "$TARGET_PROJECT"
if docker image inspect "$CURRENT_IMAGE" >/dev/null 2>&1 || docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
  n05_fail RESTORE_IMAGE_TAG_ALREADY_EXISTS
fi

write_env_file "$SOURCE_ENV_FILE" restore-source FAI_CRM_N05_RESTORE_SOURCE_V1 "$SOURCE_PROJECT" "$CURRENT_IMAGE" fai_crm_n05_source fai_crm_n05_source
write_env_file "$TARGET_ENV_FILE" restore-target FAI_CRM_N05_RESTORE_TARGET_V1 "$TARGET_PROJECT" "$CURRENT_IMAGE" fai_crm_n05_target fai_crm_n05_target
guard_identity restore-source FAI_CRM_N05_RESTORE_SOURCE_V1 "$SOURCE_PROJECT" "$SOURCE_ENV_FILE" "$CURRENT_IMAGE"
guard_identity restore-target FAI_CRM_N05_RESTORE_TARGET_V1 "$TARGET_PROJECT" "$TARGET_ENV_FILE" "$CURRENT_IMAGE"

if (
  export FAI_ENVIRONMENT=restore-source FAI_ENVIRONMENT_SENTINEL=FAI_CRM_N05_RESTORE_SOURCE_V1
  export COMPOSE_PROJECT_NAME=fai-crm COMPOSE_FILE ENV_FILE="$SOURCE_ENV_FILE" APP_ORIGIN=http://app:3000 APP_IMAGE="$CURRENT_IMAGE"
  n05_assert_environment_identity restore-source
) >/dev/null 2>&1; then
  n05_fail UNSAFE_PRODUCTION_IDENTITY_WAS_ACCEPTED
fi

docker build --pull=false \
  --build-arg "SOURCE_COMMIT=$SOURCE_COMMIT" \
  --build-arg "SOURCE_TREE=$SOURCE_TREE" \
  --label it.finanzaagevolaimpresa.environment=restore-drill \
  --label "it.finanzaagevolaimpresa.source-commit=$SOURCE_COMMIT" \
  -f "$REPO_ROOT/Dockerfile.prod.example" -t "$CURRENT_IMAGE" "$REPO_ROOT"
CURRENT_IMAGE_CREATED=true
CURRENT_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$CURRENT_IMAGE")"
[[ "$CURRENT_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || n05_fail CURRENT_IMAGE_ID_INVALID

compose_source config --quiet
SOURCE_CREATED=true
compose_source up -d postgres
wait_for_postgres source fai_crm_n05_source fai_crm_n05_source
compose_source run --rm -T app npm run prisma:migrate:deploy

synthetic_payload_hash="$(printf 'FAI_CRM_N05_SYNTHETIC_RESTORE_PAYLOAD_V1' | sha256sum | cut -d ' ' -f1)"
compose_source exec -T postgres psql -X -v ON_ERROR_STOP=1 -U fai_crm_n05_source -d fai_crm_n05_source <<SQL
COMMENT ON DATABASE fai_crm_n05_source IS 'FAI_CRM_N05_RESTORE_SOURCE_V1';
CREATE TABLE "N05SyntheticRestoreSentinel" (
  "id" TEXT PRIMARY KEY,
  "payloadHash" TEXT NOT NULL
);
INSERT INTO "N05SyntheticRestoreSentinel" ("id", "payloadHash")
VALUES ('FAI_CRM_N05_SYNTHETIC_ROW_V1', '$synthetic_payload_hash');
SQL

compose_source run --rm -T --no-deps --entrypoint sh app -c '
  set -eu
  test "$FAI_ENVIRONMENT_SENTINEL" = FAI_CRM_N05_RESTORE_SOURCE_V1
  mkdir -p /var/lib/fai-crm/documents/n05
  printf %s FAI_CRM_N05_SYNTHETIC_DOCUMENT_ALPHA_V1 > /var/lib/fai-crm/documents/n05/alpha.txt
  printf %s FAI_CRM_N05_SYNTHETIC_DOCUMENT_BETA_V1 > /var/lib/fai-crm/documents/n05/beta.txt
'
SOURCE_DOCUMENT_HASHES="$(compose_source run --rm -T --no-deps --entrypoint sh app -c \
  'cd /var/lib/fai-crm/documents && sha256sum n05/alpha.txt n05/beta.txt')"

BACKUP_SET_ID="n05-$RUN_ID"
FAI_ENVIRONMENT=restore-source \
FAI_ENVIRONMENT_SENTINEL=FAI_CRM_N05_RESTORE_SOURCE_V1 \
COMPOSE_PROJECT_NAME="$SOURCE_PROJECT" \
COMPOSE_FILE="$COMPOSE_FILE" \
ENV_FILE="$SOURCE_ENV_FILE" \
APP_ORIGIN=http://app:3000 \
APP_IMAGE="$CURRENT_IMAGE" \
BACKUP_ROOT="$BACKUP_ROOT" \
BACKUP_SET_ID="$BACKUP_SET_ID" \
SOURCE_COMMIT="$SOURCE_COMMIT" \
SOURCE_TREE="$SOURCE_TREE" \
EXPECTED_DATABASE_NAME=fai_crm_n05_source \
EXPECTED_DATABASE_SENTINEL=FAI_CRM_N05_RESTORE_SOURCE_V1 \
EXPECTED_APP_IMAGE_ID="$CURRENT_IMAGE_ID" \
BACKUP_IMAGE_PROVENANCE=oci-labels \
BACKUP_RESOURCE_PROVENANCE=n05-labels \
EXPECTED_MIGRATION_COUNT="$EXPECTED_MIGRATION_COUNT" \
BACKUP_CONSISTENCY=application-quiesced \
  "$SCRIPT_DIR/backup-compose.sh"
BACKUP_SET_DIR="$BACKUP_ROOT/$BACKUP_SET_ID"

CORRUPTED_SET="$WORK_ROOT/corrupted-backup"
cp -a "$BACKUP_SET_DIR" "$CORRUPTED_SET"
printf 'corruption' >> "$CORRUPTED_SET/postgres.dump"
if EXPECTED_ENVIRONMENT=restore-source EXPECTED_PROJECT="$SOURCE_PROJECT" \
  EXPECTED_SOURCE_COMMIT="$SOURCE_COMMIT" EXPECTED_SOURCE_TREE="$SOURCE_TREE" \
  EXPECTED_APP_IMAGE_ID="$CURRENT_IMAGE_ID" \
  EXPECTED_IMAGE_PROVENANCE=oci-labels \
  EXPECTED_RESOURCE_PROVENANCE=n05-labels \
  EXPECTED_MIGRATION_COUNT="$EXPECTED_MIGRATION_COUNT" \
  "$SCRIPT_DIR/verify-backup-manifest.sh" "$CORRUPTED_SET" >/dev/null 2>&1; then
  n05_fail CORRUPTED_BACKUP_WAS_ACCEPTED
fi

EXPECTED_ENVIRONMENT=restore-source EXPECTED_PROJECT="$SOURCE_PROJECT" \
EXPECTED_SOURCE_COMMIT="$SOURCE_COMMIT" EXPECTED_SOURCE_TREE="$SOURCE_TREE" \
EXPECTED_APP_IMAGE_ID="$CURRENT_IMAGE_ID" \
EXPECTED_IMAGE_PROVENANCE=oci-labels \
EXPECTED_RESOURCE_PROVENANCE=n05-labels \
EXPECTED_MIGRATION_COUNT="$EXPECTED_MIGRATION_COUNT" \
  "$SCRIPT_DIR/verify-backup-manifest.sh" "$BACKUP_SET_DIR"

compose_target config --quiet
TARGET_CREATED=true
compose_target up -d postgres
wait_for_postgres target fai_crm_n05_target fai_crm_n05_target
compose_target exec -T postgres psql -X -v ON_ERROR_STOP=1 -U fai_crm_n05_target -d fai_crm_n05_target \
  -c "COMMENT ON DATABASE fai_crm_n05_target IS 'FAI_CRM_N05_RESTORE_TARGET_V1'"
compose_target exec -T postgres pg_restore --list < "$BACKUP_SET_DIR/postgres.dump" >/dev/null
compose_target exec -T postgres sh -c \
  'exec pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$BACKUP_SET_DIR/postgres.dump"

compose_target run --rm -T --no-deps --entrypoint sh app -c '
  set -eu
  test "$FAI_ENVIRONMENT_SENTINEL" = FAI_CRM_N05_RESTORE_TARGET_V1
  test -z "$(find /var/lib/fai-crm/documents -mindepth 1 -print -quit)"
  tar -xzf - -C /var/lib/fai-crm/documents --no-same-owner --no-same-permissions
' < "$BACKUP_SET_DIR/documents.tar.gz"

compose_target run --rm -T app npm run prisma:migrate:deploy
target_migrations="$(compose_target exec -T postgres psql -X -v ON_ERROR_STOP=1 -U fai_crm_n05_target -d fai_crm_n05_target -Atqc \
  'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
[[ "$target_migrations" == "$EXPECTED_MIGRATION_COUNT" ]] || n05_fail RESTORED_MIGRATION_COUNT_MISMATCH

restored_sentinel="$(compose_target exec -T postgres psql -X -v ON_ERROR_STOP=1 -U fai_crm_n05_target -d fai_crm_n05_target -Atqc \
  'SELECT "id" || '\''|'\'' || "payloadHash" FROM "N05SyntheticRestoreSentinel"')"
[[ "$restored_sentinel" == "FAI_CRM_N05_SYNTHETIC_ROW_V1|$synthetic_payload_hash" ]] || n05_fail RESTORED_DATABASE_SENTINEL_MISMATCH

dormant_snapshot="$(compose_target exec -T postgres psql -X -v ON_ERROR_STOP=1 -U fai_crm_n05_target -d fai_crm_n05_target -Atqc '
SELECT COUNT(*) || '\''|'\'' || (SELECT COUNT(*) FROM "PrivacyEvidenceReceipt") FROM "PrivacyNoticeVersion";
SELECT COUNT(*) FROM "InternalSession";
SELECT COUNT(*) || '\''|'\'' || COUNT(*) FILTER (WHERE "enabled") FROM "ApplicationFeatureGate";
SELECT COUNT(*) FROM "ApplicationKeyVersion";
SELECT COUNT(*) FROM "LoginThrottleBucket";
SELECT (SELECT COUNT(*) FROM "AiRun") || '\''|'\'' || (SELECT COUNT(*) FROM "AiOutput");
SELECT (SELECT COUNT(*) FROM "AiWorkflowInstance") || '\''|'\'' || (SELECT COUNT(*) FROM "AiWorkflowJob");
')"
[[ "$dormant_snapshot" == $'0|0\n0\n6|0\n0\n0\n0|0\n0|0' ]] || n05_fail RESTORED_DORMANT_INVARIANTS_CHANGED

TARGET_DOCUMENT_HASHES="$(compose_target run --rm -T --no-deps --entrypoint sh app -c \
  'cd /var/lib/fai-crm/documents && sha256sum n05/alpha.txt n05/beta.txt')"
[[ "$TARGET_DOCUMENT_HASHES" == "$SOURCE_DOCUMENT_HASHES" ]] || n05_fail RESTORED_DOCUMENT_HASH_MISMATCH

source_documents_volume="$(docker volume ls -q --filter "label=com.docker.compose.project=$SOURCE_PROJECT" --filter label=com.docker.compose.volume=restore_documents)"
target_documents_volume="$(docker volume ls -q --filter "label=com.docker.compose.project=$TARGET_PROJECT" --filter label=com.docker.compose.volume=restore_documents)"
[[ -n "$source_documents_volume" && -n "$target_documents_volume" && "$source_documents_volume" != "$target_documents_volume" ]] \
  || n05_fail RESTORE_DOCUMENT_VOLUMES_NOT_ISOLATED

compose_target up -d app
wait_for_app target
target_app_id="$(compose_target ps -q app)"
[[ "$(docker inspect -f '{{.Image}}' "$target_app_id")" == "$CURRENT_IMAGE_ID" ]] || n05_fail RESTORED_APP_IMAGE_ID_MISMATCH
compose_target exec -T app sh -c \
  'test "$FAI_ENVIRONMENT" = restore-target && test "$FAI_ENVIRONMENT_SENTINEL" = FAI_CRM_N05_RESTORE_TARGET_V1'

git -C "$REPO_ROOT" archive "$ROLLBACK_COMMIT" | tar -x -C "$ROLLBACK_SOURCE"
docker build --pull=false \
  --build-arg "SOURCE_COMMIT=$ROLLBACK_COMMIT" \
  --build-arg "SOURCE_TREE=$ROLLBACK_TREE" \
  --label it.finanzaagevolaimpresa.environment=restore-drill-rollback \
  --label "it.finanzaagevolaimpresa.source-commit=$ROLLBACK_COMMIT" \
  -f "$ROLLBACK_SOURCE/Dockerfile.prod.example" -t "$ROLLBACK_IMAGE" "$ROLLBACK_SOURCE"
ROLLBACK_IMAGE_CREATED=true
ROLLBACK_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$ROLLBACK_IMAGE")"
[[ "$ROLLBACK_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ && "$ROLLBACK_IMAGE_ID" != "$CURRENT_IMAGE_ID" ]] \
  || n05_fail ROLLBACK_IMAGE_ID_INVALID
sed -i "s|^APP_IMAGE=.*$|APP_IMAGE=$ROLLBACK_IMAGE|" "$TARGET_ENV_FILE"
compose_target up -d --no-deps --force-recreate app
wait_for_app target
target_app_id="$(compose_target ps -q app)"
[[ "$(docker inspect -f '{{.Image}}' "$target_app_id")" == "$ROLLBACK_IMAGE_ID" ]] || n05_fail ROLLBACK_IMAGE_NOT_ACTIVE
printf 'ROLLBACK_PASS|commit=%s|image_id=%s|down_migration=none\n' "$ROLLBACK_COMMIT" "$ROLLBACK_IMAGE_ID"

if ! cleanup_resources; then
  trap - EXIT
  n05_fail RESTORE_CLEANUP_INCOMPLETE
fi
trap - EXIT
printf 'N05_RESTORE_DRILL_PASS|migrations=%s|database=verified|documents=verified|rollback=verified\n' "$target_migrations"
