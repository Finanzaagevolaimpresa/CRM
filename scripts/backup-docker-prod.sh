#!/usr/bin/env bash
set -Eeuo pipefail

# Production wrapper for the N05 manifest/checksum backup contract. It never
# stops the application: the caller must quiesce it in an approved release window.
: "${CONFIRM_PRODUCTION_BACKUP:?set CONFIRM_PRODUCTION_BACKUP=FAI_CRM_PRODUCTION_BACKUP_V1}"
[[ "$CONFIRM_PRODUCTION_BACKUP" == "FAI_CRM_PRODUCTION_BACKUP_V1" ]] || {
  printf 'N05_FAILED|code=PRODUCTION_BACKUP_CONFIRMATION_MISMATCH\n' >&2
  exit 1
}

export FAI_ENVIRONMENT=production
export FAI_ENVIRONMENT_SENTINEL=FAI_CRM_PRODUCTION_V1
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fai-crm}"
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.example.yml}"
export ENV_FILE="${ENV_FILE:-.env.production}"
export APP_ENV_FILE="${APP_ENV_FILE:-$ENV_FILE}"
export APP_ORIGIN="${APP_ORIGIN:-https://desk.finanzaagevolaimpresa.it}"
export APP_IMAGE="${APP_IMAGE:?APP_IMAGE must be the immutable deployed fai-crm:prN-<sha12> tag}"
export POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
export BACKUP_ROOT="${BACKUP_ROOT:?BACKUP_ROOT is required}"
export BACKUP_SET_ID="${BACKUP_SET_ID:?BACKUP_SET_ID is required}"
export SOURCE_COMMIT="${SOURCE_COMMIT:?SOURCE_COMMIT is required}"
export SOURCE_TREE="${SOURCE_TREE:?SOURCE_TREE is required}"
export EXPECTED_APP_IMAGE_ID="${EXPECTED_APP_IMAGE_ID:?EXPECTED_APP_IMAGE_ID is required}"
export BACKUP_IMAGE_PROVENANCE="${BACKUP_IMAGE_PROVENANCE:-oci-labels}"
export BACKUP_RESOURCE_PROVENANCE="${BACKUP_RESOURCE_PROVENANCE:-n05-labels}"
export CONFIRM_LEGACY_RESOURCE_IDENTITY="${CONFIRM_LEGACY_RESOURCE_IDENTITY:-}"
export EXPECTED_DATABASE_NAME="${EXPECTED_DATABASE_NAME:?EXPECTED_DATABASE_NAME is required}"
export EXPECTED_MIGRATION_COUNT="${EXPECTED_MIGRATION_COUNT:-36}"
export BACKUP_CONSISTENCY=application-quiesced

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/n05/backup-compose.sh"
