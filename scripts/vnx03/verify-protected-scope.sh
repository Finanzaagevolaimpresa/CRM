#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

[[ "$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == '44' ]] \
  || fail 'VNX03_MIGRATION_COUNT_INVALID'

base_sha="${VNX03_BASE_SHA:-}"
if [[ -z "$base_sha" ]] || ! git cat-file -e "$base_sha^{commit}" 2>/dev/null; then
  exit 0
fi

protected_paths=(
  prisma/schema.prisma prisma/migrations src
  Dockerfile.prod.example docker-compose.prod.example.yml
  .env.example .env.production.example .env.staging.example
)
protected_delta="$(git diff --name-only "$base_sha"...HEAD -- "${protected_paths[@]}")"

# Preserve the pre-existing harness-only case. The N15 exception is evaluated
# only when this candidate actually changes a protected runtime/schema path.
[[ -n "$protected_delta" ]] || exit 0

readonly n15_migration='prisma/migrations/20260909120000_n15_dedicated_communication_persistence_v1/migration.sql'
[[ "$(git ls-tree -d --name-only "$base_sha:prisma/migrations" | wc -l | tr -d ' ')" == '43' ]] \
  || fail 'VNX03_N15_BASE_MIGRATION_COUNT_INVALID'
[[ "$(git diff --diff-filter=A --name-only "$base_sha"...HEAD -- prisma/migrations)" == "$n15_migration" ]] \
  || fail 'VNX03_N15_MIGRATION_ADDITION_INVALID'
[[ -z "$(git diff --diff-filter=DMRTUXB --name-only "$base_sha"...HEAD -- prisma/migrations)" ]] \
  || fail 'VNX03_N15_HISTORICAL_MIGRATION_CHANGED'

echo 'b23956d412e6b9addeb0cebbb7ac07f42fbf15905b8936bfb4f819d6e9cfa770  prisma/schema.prisma' \
  | sha256sum --check --strict >/dev/null \
  || fail 'VNX03_N15_SCHEMA_BYTES_INVALID'
echo "49bb5acd948644d3da5669a497d61bd4b482f6156fad65773377c22130bade88  $n15_migration" \
  | sha256sum --check --strict >/dev/null \
  || fail 'VNX03_N15_MIGRATION_BYTES_INVALID'
echo 'cb5b47e72b8a08e373e5ba0864f7a0fca0c683fe3452c7d2448727e5d8ad6eea  src/lib/communication-intent-persistence.ts' \
  | sha256sum --check --strict >/dev/null \
  || fail 'VNX03_N15_LAYER_BYTES_INVALID'

unexpected_protected="$(printf '%s\n' "$protected_delta" \
  | grep -Fvx -e prisma/schema.prisma -e "$n15_migration" \
      -e src/lib/communication-intent-persistence.ts || true)"
[[ -z "$unexpected_protected" ]] || fail 'VNX03_FORBIDDEN_RUNTIME_OR_SCHEMA_DELTA'
