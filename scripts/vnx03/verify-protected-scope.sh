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

harness_paths=(
  tests/vnx03 tests/vnx03-e2e-harness.test.ts tests/vnx03-protected-scope.test.ts
  scripts/vnx03 docs/vnx03-wpforms-https-end-to-end-qualification-r01.md
)
harness_delta="$(git diff --name-only "$base_sha"...HEAD -- "${harness_paths[@]}")"

# This is a co-modification guard, not a global runtime-change policy. Normal
# CRM changes remain governed by their own jobs when the VNX-03 harness is untouched.
[[ -n "$harness_delta" ]] || exit 0

protected_paths=(
  prisma/schema.prisma prisma/migrations src
  Dockerfile.prod.example docker-compose.prod.example.yml
  .env.example .env.production.example .env.staging.example
)
protected_delta="$(git diff --name-only "$base_sha"...HEAD -- "${protected_paths[@]}")"

# Preserve the pre-existing harness-only case. The N15 exception is evaluated
# only when a harness change also modifies a protected runtime/schema path.
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
echo "b023cf7a24f2ee9020e2d40da88aa3d229dfff079e4b62c7c0842a01a102766b  $n15_migration" \
  | sha256sum --check --strict >/dev/null \
  || fail 'VNX03_N15_MIGRATION_BYTES_INVALID'
echo 'c809e1de8563a2bb006d7de5a6c7bab881eea7c27d18e46a2b5b09ce8b3d2055  src/lib/communication-intent-persistence.ts' \
  | sha256sum --check --strict >/dev/null \
  || fail 'VNX03_N15_LAYER_BYTES_INVALID'

unexpected_protected="$(printf '%s\n' "$protected_delta" \
  | grep -Fvx -e prisma/schema.prisma -e "$n15_migration" \
      -e src/lib/communication-intent-persistence.ts || true)"
[[ -z "$unexpected_protected" ]] || fail 'VNX03_FORBIDDEN_RUNTIME_OR_SCHEMA_DELTA'
