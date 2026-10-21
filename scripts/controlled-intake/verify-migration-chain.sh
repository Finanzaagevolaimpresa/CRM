#!/usr/bin/env bash
set -euo pipefail
base="${1:-c49b18ccc4df713e212e8e4f2f05100638aee317}"
schema45="${2:-b8fbb9f7841d6f9639a93393909592432ab927ce}"
new_path='prisma/migrations/20260914090000_controlled_intake_four_channels_v1/migration.sql'
readiness_path='prisma/migrations/20260914130000_practice_engagement_readiness_v1/migration.sql'
perimeter_path='prisma/migrations/20260924100000_admin_client_read_perimeters_v1/migration.sql'
communications_path='prisma/migrations/20260927010000_approved_manual_communications_v1/migration.sql'

dossier_path='prisma/migrations/20260920090000_engagement_dossier_approval_delivery_v1/migration.sql'
[[ "$(git diff --name-only "$base"...HEAD -- prisma/migrations)" == "$new_path"$'\n'"$readiness_path"$'\n'"$dossier_path"$'\n'"$perimeter_path"$'\n'"$communications_path"$'\n'"prisma/migrations/20261015090000_selective_project_access_v1/migration.sql"$'\n'"prisma/migrations/20261017120000_ordinary_email_v1/migration.sql"$'\n'"prisma/migrations/20261017160000_admin_email_contexts_v1/migration.sql"$'\n'"prisma/migrations/20261017200000_record_update_notifications_v1/migration.sql"$'\n'"prisma/migrations/20261018000000_private_video_library_v1/migration.sql"$'\n'"prisma/migrations/20261018060000_record_update_email_drafts_v1/migration.sql"$'\n'"prisma/migrations/20261018140000_selective_lead_read_v1/migration.sql"$'\n'"prisma/migrations/20261018190000_selective_client_read_v1/migration.sql"$'\n'"prisma/migrations/20261018220000_selective_practice_read_v1/migration.sql"$'\n'"prisma/migrations/20261021080000_selective_client_documents_v1/migration.sql"$'\n'"prisma/migrations/20261021110000_selective_practice_documents_v1/migration.sql"$'\n'"prisma/migrations/20261021170000_selective_client_company_fields_v1/migration.sql" ]]
[[ "$(git ls-tree -r --name-only "$base" -- prisma/migrations | sed -n '/\/migration.sql$/p' | wc -l | tr -d ' ')" == 44 ]]
[[ "$(git ls-tree -r --name-only "$schema45" -- prisma/migrations | sed -n '/\/migration.sql$/p' | wc -l | tr -d ' ')" == 45 ]]
[[ "$(find prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql | wc -l | tr -d ' ')" == 61 ]]
git diff --quiet "$base"...HEAD -- $(git ls-tree -r --name-only "$base" -- prisma/migrations)
git diff --quiet "$schema45" HEAD -- $(git ls-tree -r --name-only "$schema45" -- prisma/migrations)
grep -q '^model ControlledIntake {' prisma/schema.prisma
grep -q '^model ControlledIntakeDuplicateCandidate {' prisma/schema.prisma
grep -q '^model ControlledIntakeDuplicateDecision {' prisma/schema.prisma

node scripts/m4/verify-schema.mjs
