#!/usr/bin/env bash
set -euo pipefail
base="${1:-c49b18ccc4df713e212e8e4f2f05100638aee317}"
schema45="${2:-b8fbb9f7841d6f9639a93393909592432ab927ce}"
new_path='prisma/migrations/20260914090000_controlled_intake_four_channels_v1/migration.sql'
readiness_path='prisma/migrations/20260914130000_practice_engagement_readiness_v1/migration.sql'
[[ "$(git diff --name-only "$base"...HEAD -- prisma/migrations)" == "$new_path"$'\n'"$readiness_path" ]]
[[ "$(git ls-tree -r --name-only "$base" -- prisma/migrations | sed -n '/\/migration.sql$/p' | wc -l | tr -d ' ')" == 44 ]]
[[ "$(git ls-tree -r --name-only "$schema45" -- prisma/migrations | sed -n '/\/migration.sql$/p' | wc -l | tr -d ' ')" == 45 ]]
[[ "$(find prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql | wc -l | tr -d ' ')" == 46 ]]
git diff --quiet "$base"...HEAD -- $(git ls-tree -r --name-only "$base" -- prisma/migrations)
git diff --quiet "$schema45" HEAD -- $(git ls-tree -r --name-only "$schema45" -- prisma/migrations)
grep -q '^model ControlledIntake {' prisma/schema.prisma
grep -q '^model ControlledIntakeDuplicateCandidate {' prisma/schema.prisma
grep -q '^model ControlledIntakeDuplicateDecision {' prisma/schema.prisma
