#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

BACKUP_SET_DIR="${1:?usage: verify-backup-manifest.sh BACKUP_SET_DIR}"
EXPECTED_ENVIRONMENT="${EXPECTED_ENVIRONMENT:?EXPECTED_ENVIRONMENT is required}"
EXPECTED_PROJECT="${EXPECTED_PROJECT:?EXPECTED_PROJECT is required}"
EXPECTED_SOURCE_COMMIT="${EXPECTED_SOURCE_COMMIT:?EXPECTED_SOURCE_COMMIT is required}"
EXPECTED_SOURCE_TREE="${EXPECTED_SOURCE_TREE:?EXPECTED_SOURCE_TREE is required}"
EXPECTED_APP_IMAGE_ID="${EXPECTED_APP_IMAGE_ID:?EXPECTED_APP_IMAGE_ID is required}"
EXPECTED_IMAGE_PROVENANCE="${EXPECTED_IMAGE_PROVENANCE:?EXPECTED_IMAGE_PROVENANCE is required}"
EXPECTED_RESOURCE_PROVENANCE="${EXPECTED_RESOURCE_PROVENANCE:?EXPECTED_RESOURCE_PROVENANCE is required}"
EXPECTED_MIGRATION_COUNT="${EXPECTED_MIGRATION_COUNT:-35}"

n05_assert_safe_token "$EXPECTED_PROJECT" EXPECTED_PROJECT
n05_assert_git_oid "$EXPECTED_SOURCE_COMMIT" EXPECTED_SOURCE_COMMIT
n05_assert_git_oid "$EXPECTED_SOURCE_TREE" EXPECTED_SOURCE_TREE
[[ "$EXPECTED_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || n05_fail INVALID_APP_IMAGE_ID
[[ "$EXPECTED_IMAGE_PROVENANCE" == "oci-labels" || "$EXPECTED_IMAGE_PROVENANCE" == "authorized-legacy-image-id" ]] \
  || n05_fail INVALID_IMAGE_PROVENANCE
[[ "$EXPECTED_RESOURCE_PROVENANCE" == "n05-labels" || "$EXPECTED_RESOURCE_PROVENANCE" == "authorized-legacy-compose-identity" ]] \
  || n05_fail INVALID_RESOURCE_PROVENANCE
if [[ "$EXPECTED_RESOURCE_PROVENANCE" == "authorized-legacy-compose-identity" ]]; then
  [[ "$EXPECTED_ENVIRONMENT" == "production" && "$EXPECTED_PROJECT" == "fai-crm" ]] \
    || n05_fail LEGACY_RESOURCE_MANIFEST_PRODUCTION_ONLY
fi
[[ "$EXPECTED_MIGRATION_COUNT" =~ ^[0-9]{1,4}$ ]] || n05_fail INVALID_MIGRATION_COUNT

BACKUP_SET_DIR="$(n05_realpath "$BACKUP_SET_DIR")"
[[ -d "$BACKUP_SET_DIR" && ! -L "$BACKUP_SET_DIR" ]] || n05_fail BACKUP_SET_NOT_DIRECTORY
[[ "$(stat -c '%a' "$BACKUP_SET_DIR")" == "700" ]] || n05_fail BACKUP_SET_PERMISSIONS
MANIFEST="$BACKUP_SET_DIR/MANIFEST.txt"
CHECKSUMS="$BACKUP_SET_DIR/SHA256SUMS"
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || n05_fail MANIFEST_NOT_REGULAR
[[ -f "$CHECKSUMS" && ! -L "$CHECKSUMS" ]] || n05_fail CHECKSUMS_NOT_REGULAR
[[ "$(stat -c '%a' "$MANIFEST")" == "600" && "$(stat -c '%a' "$CHECKSUMS")" == "600" ]] \
  || n05_fail BACKUP_METADATA_PERMISSIONS

declare -A values=()
declare -A allowed=(
  [schema]=1 [environment]=1 [environment_sentinel]=1 [compose_project]=1
  [created_at]=1 [consistency]=1 [source_commit]=1 [source_tree]=1
  [app_image_id]=1 [image_provenance]=1 [resource_provenance]=1
  [migration_count]=1 [database_file]=1 [documents_file]=1
)

while IFS='=' read -r key value; do
  [[ -n "$key" && -n "${allowed[$key]:-}" ]] || n05_fail MANIFEST_UNKNOWN_KEY
  [[ -z "${values[$key]+x}" ]] || n05_fail MANIFEST_DUPLICATE_KEY
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || n05_fail MANIFEST_INVALID_VALUE
  values[$key]="$value"
done < "$MANIFEST"

for key in "${!allowed[@]}"; do
  [[ -n "${values[$key]:-}" ]] || n05_fail MANIFEST_MISSING_KEY
done

[[ "${values[schema]}" == "FAI_CRM_N05_BACKUP_V1" ]] || n05_fail MANIFEST_SCHEMA_MISMATCH
[[ "${values[environment]}" == "$EXPECTED_ENVIRONMENT" ]] || n05_fail MANIFEST_ENVIRONMENT_MISMATCH
[[ "${values[compose_project]}" == "$EXPECTED_PROJECT" ]] || n05_fail MANIFEST_PROJECT_MISMATCH
[[ "${values[consistency]}" == "application-quiesced" ]] || n05_fail MANIFEST_NOT_QUIESCED
[[ "${values[source_commit]}" == "$EXPECTED_SOURCE_COMMIT" ]] || n05_fail MANIFEST_COMMIT_MISMATCH
[[ "${values[source_tree]}" == "$EXPECTED_SOURCE_TREE" ]] || n05_fail MANIFEST_TREE_MISMATCH
[[ "${values[app_image_id]}" == "$EXPECTED_APP_IMAGE_ID" ]] || n05_fail MANIFEST_APP_IMAGE_ID_MISMATCH
[[ "${values[image_provenance]}" == "$EXPECTED_IMAGE_PROVENANCE" ]] || n05_fail MANIFEST_IMAGE_PROVENANCE_MISMATCH
[[ "${values[resource_provenance]}" == "$EXPECTED_RESOURCE_PROVENANCE" ]] || n05_fail MANIFEST_RESOURCE_PROVENANCE_MISMATCH
[[ "${values[migration_count]}" == "$EXPECTED_MIGRATION_COUNT" ]] || n05_fail MANIFEST_MIGRATION_MISMATCH
[[ "${values[created_at]}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || n05_fail MANIFEST_TIMESTAMP_INVALID

case "$EXPECTED_ENVIRONMENT" in
  production) expected_sentinel="FAI_CRM_PRODUCTION_V1" ;;
  staging) expected_sentinel="FAI_CRM_STAGING_ISOLATED_V1" ;;
  restore-source) expected_sentinel="FAI_CRM_N05_RESTORE_SOURCE_V1" ;;
  *) n05_fail MANIFEST_EXPECTED_ENVIRONMENT_INVALID ;;
esac
[[ "${values[environment_sentinel]}" == "$expected_sentinel" ]] || n05_fail MANIFEST_SENTINEL_MISMATCH

for key in database_file documents_file; do
  file_name="${values[$key]}"
  [[ "$file_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$ ]] || n05_fail MANIFEST_FILENAME_INVALID
  [[ -f "$BACKUP_SET_DIR/$file_name" && ! -L "$BACKUP_SET_DIR/$file_name" ]] || n05_fail MANIFEST_ARTIFACT_NOT_REGULAR
  [[ "$(stat -c '%a' "$BACKUP_SET_DIR/$file_name")" == "600" ]] || n05_fail MANIFEST_ARTIFACT_PERMISSIONS
done

(
  cd "$BACKUP_SET_DIR"
  [[ "$(wc -l < SHA256SUMS | tr -d ' ')" == "2" ]] || n05_fail CHECKSUM_COUNT_MISMATCH
  mapfile -t checksum_files < <(awk '{print $2}' SHA256SUMS | LC_ALL=C sort)
  mapfile -t expected_checksum_files < <(printf '%s\n%s\n' "${values[database_file]}" "${values[documents_file]}" | LC_ALL=C sort)
  [[ "${checksum_files[*]}" == "${expected_checksum_files[*]}" ]] || n05_fail CHECKSUM_FILENAMES_MISMATCH
  sha256sum --strict --check SHA256SUMS >/dev/null
) || n05_fail CHECKSUM_VALIDATION_FAILED

n05_assert_archive_safe "$BACKUP_SET_DIR/${values[documents_file]}"

printf 'N05_BACKUP_MANIFEST_PASS|environment=%s|project=%s|migrations=%s\n' \
  "$EXPECTED_ENVIRONMENT" "$EXPECTED_PROJECT" "$EXPECTED_MIGRATION_COUNT"
