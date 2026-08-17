#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

: "${EXPECTED_BRANCH:?EXPECTED_BRANCH is required}"
: "${EXPECTED_COMMIT:?EXPECTED_COMMIT is required}"
: "${EXPECTED_TREE:?EXPECTED_TREE is required}"
: "${EXPECTED_FIRST_PARENT:?EXPECTED_FIRST_PARENT is required}"
: "${AUTHORIZED_CI_SHA:?AUTHORIZED_CI_SHA is required}"
: "${CI_CONCLUSION:?CI_CONCLUSION is required}"
: "${INCOMPATIBLE_PR_COUNT:?INCOMPATIBLE_PR_COUNT is required}"
: "${EXPECTED_IMAGE_ID:?EXPECTED_IMAGE_ID is required}"
: "${ROLLBACK_IMAGE:?ROLLBACK_IMAGE is required}"
: "${EXPECTED_ROLLBACK_IMAGE_ID:?EXPECTED_ROLLBACK_IMAGE_ID is required}"
: "${ROLLBACK_IMAGE_PROVENANCE:?ROLLBACK_IMAGE_PROVENANCE is required}"
: "${BACKUP_SET_DIR:?BACKUP_SET_DIR is required}"
: "${BACKUP_SOURCE_COMMIT:?BACKUP_SOURCE_COMMIT is required}"
: "${BACKUP_SOURCE_TREE:?BACKUP_SOURCE_TREE is required}"
: "${BACKUP_APP_IMAGE_ID:?BACKUP_APP_IMAGE_ID is required}"
: "${BACKUP_IMAGE_PROVENANCE:?BACKUP_IMAGE_PROVENANCE is required}"
: "${BACKUP_SOURCE_PROJECT:?BACKUP_SOURCE_PROJECT is required}"

n05_require_command docker
n05_require_command git
n05_require_command sha256sum
n05_assert_environment_identity production
n05_assert_git_oid "$EXPECTED_COMMIT" EXPECTED_COMMIT
n05_assert_git_oid "$EXPECTED_TREE" EXPECTED_TREE
n05_assert_git_oid "$EXPECTED_FIRST_PARENT" EXPECTED_FIRST_PARENT
n05_assert_git_oid "$AUTHORIZED_CI_SHA" AUTHORIZED_CI_SHA
n05_assert_git_oid "$BACKUP_SOURCE_COMMIT" BACKUP_SOURCE_COMMIT
n05_assert_git_oid "$BACKUP_SOURCE_TREE" BACKUP_SOURCE_TREE
[[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || n05_fail EXPECTED_IMAGE_ID_INVALID
[[ "$EXPECTED_ROLLBACK_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || n05_fail EXPECTED_ROLLBACK_IMAGE_ID_INVALID
n05_assert_safe_token "${ROLLBACK_IMAGE//\//-}" ROLLBACK_IMAGE
[[ "$BACKUP_APP_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || n05_fail BACKUP_APP_IMAGE_ID_INVALID
[[ "$BACKUP_IMAGE_PROVENANCE" == "oci-labels" || "$BACKUP_IMAGE_PROVENANCE" == "authorized-legacy-image-id" ]] \
  || n05_fail BACKUP_IMAGE_PROVENANCE_INVALID
[[ "$ROLLBACK_IMAGE_PROVENANCE" == "oci-labels" || "$ROLLBACK_IMAGE_PROVENANCE" == "authorized-legacy-image-id" ]] \
  || n05_fail ROLLBACK_IMAGE_PROVENANCE_MODE_INVALID
[[ -z "${EXPECTED_SECOND_PARENT:-}" ]] || n05_assert_git_oid "$EXPECTED_SECOND_PARENT" EXPECTED_SECOND_PARENT
[[ "$CI_CONCLUSION" == "success" ]] || n05_fail CI_NOT_SUCCESSFUL
[[ "$AUTHORIZED_CI_SHA" == "$EXPECTED_COMMIT" ]] || n05_fail CI_SHA_MISMATCH
[[ "$INCOMPATIBLE_PR_COUNT" == "0" ]] || n05_fail INCOMPATIBLE_PR_PRESENT
[[ "$EXPECTED_BRANCH" == "main" ]] || n05_fail PRODUCTION_RELEASE_BRANCH_MUST_BE_MAIN
[[ "$ROLLBACK_IMAGE" =~ ^fai-crm:pr[0-9]+-${EXPECTED_FIRST_PARENT:0:12}$ ]] || n05_fail ROLLBACK_IMAGE_TAG_SHA_MISMATCH

actual_branch="$(git -C "$REPO_ROOT" branch --show-current)"
actual_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
actual_tree="$(git -C "$REPO_ROOT" rev-parse HEAD^{tree})"
[[ "$actual_branch" == "$EXPECTED_BRANCH" ]] || n05_fail GIT_BRANCH_MISMATCH
[[ "$actual_commit" == "$EXPECTED_COMMIT" ]] || n05_fail GIT_COMMIT_MISMATCH
[[ "$actual_tree" == "$EXPECTED_TREE" ]] || n05_fail GIT_TREE_MISMATCH
[[ -z "$(git -C "$REPO_ROOT" status --porcelain=v1)" ]] || n05_fail GIT_WORKTREE_NOT_CLEAN

read -r commit parent_one parent_two extra < <(git -C "$REPO_ROOT" rev-list --parents -n 1 HEAD)
[[ "$commit" == "$EXPECTED_COMMIT" && "$parent_one" == "$EXPECTED_FIRST_PARENT" && -z "${extra:-}" ]] \
  || n05_fail GIT_PARENT_SET_INVALID
if [[ -n "${EXPECTED_SECOND_PARENT:-}" ]]; then
  [[ "$parent_two" == "$EXPECTED_SECOND_PARENT" ]] || n05_fail GIT_SECOND_PARENT_MISMATCH
else
  [[ -z "${parent_two:-}" ]] || n05_fail UNEXPECTED_SECOND_PARENT
fi

remote_main="$(git -C "$REPO_ROOT" ls-remote origin refs/heads/main | awk '{print $1}')"
[[ "$remote_main" == "$EXPECTED_COMMIT" ]] || n05_fail REMOTE_MAIN_MISMATCH
repo_migration_count="$(find "$REPO_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[[ "$repo_migration_count" == "${EXPECTED_MIGRATION_COUNT:-35}" ]] || n05_fail REPOSITORY_MIGRATION_COUNT_MISMATCH

actual_image_id="$(docker image inspect -f '{{.Id}}' "$APP_IMAGE")"
actual_rollback_image_id="$(docker image inspect -f '{{.Id}}' "$ROLLBACK_IMAGE")"
actual_image_commit="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$APP_IMAGE")"
actual_image_tree="$(docker image inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}' "$APP_IMAGE")"
actual_rollback_image_commit="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ROLLBACK_IMAGE")"
actual_rollback_image_tree="$(docker image inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}' "$ROLLBACK_IMAGE")"
[[ "$actual_rollback_image_commit" == "<no value>" ]] && actual_rollback_image_commit=""
[[ "$actual_rollback_image_tree" == "<no value>" ]] && actual_rollback_image_tree=""
expected_rollback_tree="$(git -C "$REPO_ROOT" rev-parse "$EXPECTED_FIRST_PARENT^{tree}")"
[[ "$actual_image_id" == "$EXPECTED_IMAGE_ID" && "$actual_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || n05_fail RELEASE_IMAGE_ID_MISMATCH
[[ "$actual_rollback_image_id" == "$EXPECTED_ROLLBACK_IMAGE_ID" && "$actual_rollback_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || n05_fail ROLLBACK_IMAGE_ID_MISMATCH
[[ "$actual_image_id" != "$actual_rollback_image_id" ]] || n05_fail RELEASE_AND_ROLLBACK_IMAGES_IDENTICAL
[[ "$APP_IMAGE" == *"${EXPECTED_COMMIT:0:12}" ]] || n05_fail RELEASE_IMAGE_TAG_SHA_MISMATCH
[[ "$actual_image_commit" == "$EXPECTED_COMMIT" && "$actual_image_tree" == "$EXPECTED_TREE" ]] \
  || n05_fail RELEASE_IMAGE_PROVENANCE_MISMATCH
case "$ROLLBACK_IMAGE_PROVENANCE" in
  oci-labels)
    [[ "$actual_rollback_image_commit" == "$EXPECTED_FIRST_PARENT" && "$actual_rollback_image_tree" == "$expected_rollback_tree" ]] \
      || n05_fail ROLLBACK_IMAGE_PROVENANCE_MISMATCH
    ;;
  authorized-legacy-image-id)
    [[ -z "$actual_rollback_image_commit" && -z "$actual_rollback_image_tree" ]] \
      || n05_fail LEGACY_ROLLBACK_HAS_UNEXPECTED_PROVENANCE
    ;;
esac

EXPECTED_ENVIRONMENT=production \
EXPECTED_PROJECT="$BACKUP_SOURCE_PROJECT" \
EXPECTED_SOURCE_COMMIT="$BACKUP_SOURCE_COMMIT" \
EXPECTED_SOURCE_TREE="$BACKUP_SOURCE_TREE" \
EXPECTED_APP_IMAGE_ID="$BACKUP_APP_IMAGE_ID" \
EXPECTED_IMAGE_PROVENANCE="$BACKUP_IMAGE_PROVENANCE" \
EXPECTED_MIGRATION_COUNT="${EXPECTED_MIGRATION_COUNT:-35}" \
  "$SCRIPT_DIR/verify-backup-manifest.sh" "$BACKUP_SET_DIR" >/dev/null

printf 'N05_RELEASE_GATE_PASS|commit=%s|tree=%s|ci=success|image_id=%s|backup=verified|rollback_image_id=%s\n' \
  "$EXPECTED_COMMIT" "$EXPECTED_TREE" "$actual_image_id" "$actual_rollback_image_id"
