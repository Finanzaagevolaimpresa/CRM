#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true ]] || { echo R05_CI_ONLY >&2; exit 1; }
[[ "$(hostname)" != fai-crm-prod-02 ]] || { echo R05_PRODUCTION_DENIED >&2; exit 1; }
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || exit 1
root="$(git rev-parse --show-toplevel)"
cd "$root"
head="$(git rev-parse HEAD)"
tree="$(git rev-parse HEAD^{tree})"
recovery_head=73432464d741164fd76690bbdef65b17d626e6e9
recovery_tree=5ee2c7819c31f772fc04bc4a28784ab7b005af25
[[ "$(git rev-parse "$recovery_head^{tree}")" == "$recovery_tree" ]]
# The return image includes schema48 perimeters, responsibility and paid-service handoff.
# Older storage-only receipts remain historical evidence, never recovery admission.
node scripts/r05/verify-perimeter-schema.mjs
git diff --exit-code "$recovery_head" -- $(git ls-tree -r --name-only "$recovery_head" -- prisma/migrations)
node scripts/vnx00a-build-context-guard.mjs
prefix="fai-crm-r05-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
evidence="$RUNNER_TEMP/$prefix-evidence"
source_candidate="$RUNNER_TEMP/$prefix-candidate"
source_recovery="$RUNNER_TEMP/$prefix-recovery"
for dir in "$evidence" "$source_candidate" "$source_recovery"; do [[ ! -e "$dir" ]] || exit 1; done
[[ -z "$(docker ps -aq --filter "name=^/$prefix-")" ]] || exit 1
if docker network inspect "$prefix" >/dev/null 2>&1; then exit 1; fi
if docker volume inspect "$prefix-documents" >/dev/null 2>&1; then exit 1; fi
mkdir -p "$evidence" "$source_candidate" "$source_recovery"
printf 'R05_EVIDENCE_DIR=%s\n' "$evidence" >> "$GITHUB_ENV"
git archive "$head" | tar -x -C "$source_candidate"
git archive "$recovery_head" | tar -x -C "$source_recovery"
candidate_image="fai-crm:r05-candidate-$head"
recovery_image="fai-crm:r05-recovery-$recovery_head"
docker build -f "$source_candidate/Dockerfile.prod.example" --build-arg SOURCE_COMMIT="$head" --build-arg SOURCE_TREE="$tree" -t "$candidate_image" "$source_candidate"
docker build -f "$source_recovery/Dockerfile.prod.example" --build-arg SOURCE_COMMIT="$recovery_head" --build-arg SOURCE_TREE="$recovery_tree" -t "$recovery_image" "$source_recovery"
candidate_id="$(docker image inspect -f '{{.Id}}' "$candidate_image")"
recovery_id="$(docker image inspect -f '{{.Id}}' "$recovery_image")"
[[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate_id")" == "$head" ]]
[[ "$(docker image inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}' "$candidate_id")" == "$tree" ]]
[[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$recovery_id")" == "$recovery_head" ]]
[[ "$(docker image inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}' "$recovery_id")" == "$recovery_tree" ]]
pg="$prefix-postgres"
app="$prefix-app"
pg_forwarder=''
app_forwarder=''
stop_app() {
  if [[ -n "$app_forwarder" ]]; then kill "$app_forwarder" 2>/dev/null || true; wait "$app_forwarder" 2>/dev/null || true; app_forwarder=''; fi
  docker rm -f "$app" >/dev/null 2>&1 || true
}
cleanup() {
  stop_app
  if [[ -n "$pg_forwarder" ]]; then kill "$pg_forwarder" 2>/dev/null || true; wait "$pg_forwarder" 2>/dev/null || true; fi
  docker rm -f "$pg" >/dev/null 2>&1 || true
  docker volume rm "$prefix-documents" >/dev/null 2>&1 || true
  docker network rm "$prefix" >/dev/null 2>&1 || true
}
docker network create --internal --label fai.synthetic=r05 "$prefix" >/dev/null
trap cleanup EXIT
docker volume create --label fai.synthetic=r05 "$prefix-documents" >/dev/null
db_password="$(openssl rand -hex 24)"
password="$(openssl rand -base64 36 | tr -d '\n')"
secret="$(openssl rand -hex 32)"
tls_key="$RUNNER_TEMP/$prefix-tls.key"
tls_cert="$RUNNER_TEMP/$prefix-tls.crt"
[[ ! -e "$tls_key" && ! -e "$tls_cert" ]] || exit 1
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -keyout "$tls_key" -out "$tls_cert" \
  -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 >/dev/null 2>&1
export NODE_EXTRA_CA_CERTS="$tls_cert"
export PR140_CI_CERT_SPKI="$(openssl x509 -in "$tls_cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A)"
printf '::add-mask::%s\n' "$db_password" "$password" "$secret"
docker run -d --name "$pg" --network "$prefix" --network-alias postgres --label fai.synthetic=r05 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$db_password" -e POSTGRES_DB=fai_crm_test postgres:16 >/dev/null
for attempt in $(seq 1 60); do
  # The temporary init server accepts Unix sockets before the final TCP listener exists.
  if docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres -d fai_crm_test >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres -d fai_crm_test >/dev/null
docker exec "$pg" psql -U postgres -d fai_crm_test -v ON_ERROR_STOP=1 -c "COMMENT ON DATABASE fai_crm_test IS 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1'" >/dev/null
bridge_ip() { docker inspect -f "{{with index .NetworkSettings.Networks \"$prefix\"}}{{.IPAddress}}{{end}}" "$1"; }
node scripts/pr140/ci-loopback-forwarder.mjs "$(bridge_ip "$pg")" 15432 5432 &
pg_forwarder=$!
sleep 1
kill -0 "$pg_forwarder"
export DATABASE_URL="postgresql://postgres:$db_password@127.0.0.1:15432/fai_crm_test?schema=public"
export APP_ENV=test NODE_ENV=development TZ=UTC RUN_DB_TESTS=1 AI_ORCHESTRATOR_DB_TESTS_CONFIRMED=1
export AI_ORCHESTRATOR_DB_TEST_SENTINEL=FAI_CRM_EPHEMERAL_TEST_ONLY_V1
export AUTH_SECRET="$secret" AUTH_COOKIE_NAME=fai_r05_synthetic_session
export PRACTICE_READINESS_BROWSER_PASSWORD="$password" PRACTICE_READINESS_BROWSER_CONFIRMED=1
export PRACTICE_READINESS_BROWSER_ORIGIN=https://127.0.0.1:13000
export PRACTICE_READINESS_BROWSER_EVIDENCE_DIR="$evidence/browser"
export PRACTICE_READINESS_PACKAGED=1
export INTERNAL_SESSION_MODE=registry
export LOCAL_DOCUMENT_STORAGE_ROOT="$RUNNER_TEMP/$prefix-m1-documents"
export R05_M1_RECOVERY_FIXTURE="$evidence/m1-fixture.json"
[[ ! -e "$LOCAL_DOCUMENT_STORAGE_ROOT" && ! -e "$R05_M1_RECOVERY_FIXTURE" ]] || exit 1
mkdir -p "$PRACTICE_READINESS_BROWSER_EVIDENCE_DIR"
npm run prisma:migrate:deploy
node --import tsx tests/pr140-release/state.ts actors
pg_id="$(docker inspect -f '{{.Id}}' "$pg")"
pg_started="$(docker inspect -f '{{.State.StartedAt}}' "$pg")"
start_app() {
  local image="$1" session_mode="$2" engagement_mode="$3" feature_mode="$4"
  docker run -d --name "$app" --network "$prefix" --label fai.synthetic=r05 \
    -v "$prefix-documents:/var/lib/fai-crm/documents" \
    -e LOCAL_DOCUMENT_STORAGE_ROOT=/var/lib/fai-crm/documents \
    -e DATABASE_URL="postgresql://postgres:$db_password@postgres:5432/fai_crm_test?schema=public" \
    -e APP_ENV=production -e NODE_ENV=production -e AUTH_SECRET="$secret" -e AUTH_COOKIE_NAME="$AUTH_COOKIE_NAME" \
    -e APP_ORIGIN="$PRACTICE_READINESS_BROWSER_ORIGIN" -e INTERNAL_SESSION_MODE="$session_mode" \
    -e __NEXT_PRIVATE_ORIGIN=http://127.0.0.1:3000 \
    -e INTERNAL_ENGAGEMENT_MODE="$engagement_mode" -e PRACTICE_READINESS_MODE="$feature_mode" -e CONTROLLED_INTAKE_MODE="$feature_mode" \
    -e LOGIN_THROTTLE_MODE=disabled -e PRIVILEGED_ACCESS_MODE=disabled -e SECURITY_HEADERS_MODE=report-only \
    -e COMMERCIAL_LEAD_INBOX_MODE=disabled -e WEBSITE_LEAD_MODE=disabled \
    -e FEATURE_INTEGRATIONS_ENABLED=false -e FEATURE_AI_WORKER_ENABLED=false -e FEATURE_AI_DISPATCH_ENABLED=false \
    -e FEATURE_AI_EGRESS_ENABLED=false -e AI_EXTERNAL_PROVIDERS_ENABLED=false -e AI_ORCHESTRATOR_WORKER_ENABLED=0 -e AI_PROVIDER=mock \
    -e TZ=UTC "$image" >/dev/null
  node scripts/pr140/ci-loopback-forwarder.mjs "$(bridge_ip "$app")" 13000 3000 "$tls_key" "$tls_cert" &
  app_forwarder=$!
}
wait_healthy() {
  for attempt in $(seq 1 120); do
    if curl --cacert "$tls_cert" --fail --silent --max-time 2 "$PRACTICE_READINESS_BROWSER_ORIGIN/api/health" >/dev/null; then return 0; fi
    [[ "$(docker inspect -f '{{.State.Running}}' "$app")" == true ]] || { docker logs "$app" 2>&1 | tail -25; return 1; }
    sleep 1
  done
  docker logs "$app" 2>&1 | tail -25
  return 1
}
expect_startup_denied() {
  local marker="$1"
  for attempt in $(seq 1 60); do
    if curl --cacert "$tls_cert" --fail --silent --max-time 2 "$PRACTICE_READINESS_BROWSER_ORIGIN/api/health" >/dev/null; then echo R05_STARTUP_GATE_BYPASSED; return 1; fi
    if docker logs "$app" 2>&1 | grep -F "$marker" >/dev/null; then return 0; fi
    sleep 1
  done
  docker logs "$app" 2>&1 | tail -25
  return 1
}
run_browser() {
  local name="$1" config="$2" match="$3" expected="$4"
  PLAYWRIGHT_JSON_OUTPUT_NAME="$evidence/$name.json" npx playwright test --config "$config" "$match" --reporter=line,json > "$evidence/$name.log" 2>&1 || {
    tail -70 "$evidence/$name.log"
    docker logs "$app" 2>&1 | tail -40
    return 1
  }
  node - "$evidence/$name.json" "$expected" <<'NODE'
const fs = require('node:fs'), assert = require('node:assert/strict');
const result = JSON.parse(fs.readFileSync(process.argv[2]));
assert.equal(result.stats.expected, Number(process.argv[3]));
assert.equal(result.stats.unexpected, 0);
assert.equal(result.stats.skipped, 0);
assert.equal(result.errors.length, 0);
fs.writeFileSync(process.argv[2].replace('.json', '-summary.json'), JSON.stringify({ synthetic:true, pass:result.stats.expected, fail:0, skip:0 })+'\n');
NODE
}
start_app "$candidate_id" registry controlled internal
wait_healthy
docker exec "$app" node -e 'require("node:fs").writeFileSync("/var/lib/fai-crm/documents/r05-synthetic.txt","PR140 synthetic persistent document\n")'
document_before="$(docker exec "$app" sha256sum /var/lib/fai-crm/documents/r05-synthetic.txt | cut -d ' ' -f1)"
run_browser entry tests/pr140-release/playwright.config.ts entry.spec.ts 1
node --import tsx tests/pr140-release/state.ts admission > "$evidence/admission.json"
node --import tsx tests/practice-readiness-browser/provision.ts
run_browser candidate tests/practice-readiness-browser/playwright.config.ts readiness.spec.ts 2
node --import tsx tests/pr140-release/state.ts m1-history "$R05_M1_RECOVERY_FIXTURE"
# Only the fresh, synthetic fixture directory is copied; extraction runs as app UID1001.
tar -C "$LOCAL_DOCUMENT_STORAGE_ROOT" -cf - . | docker exec -i "$app" tar -xpf - -C /var/lib/fai-crm/documents
run_browser candidate-m1 tests/pr140-release/playwright.config.ts m1-recovery.spec.ts 2
node --import tsx tests/pr140-release/state.ts footprint "$evidence/before-recovery.json"
# Explicit synthetic application failure; PostgreSQL and documents remain running/intact.
stop_app
start_app "$candidate_id" invalid controlled internal
expect_startup_denied 'Internal session mode is not configured canonically'
stop_app
# Prove that recovery cannot silently resurrect pre-fault registry sessions.
start_app "$recovery_id" registry controlled internal
expect_startup_denied INTERNAL_SESSION_REGISTRY_ACTIVATION_BLOCKED
stop_app
node --import tsx tests/pr140-release/state.ts revoke-sessions > "$evidence/session-revocation.json"
start_app "$recovery_id" registry controlled internal
wait_healthy
[[ "$(docker inspect -f '{{.Image}}' "$app")" == "$recovery_id" ]]
run_browser recovery tests/pr140-release/playwright.config.ts '/recovery.spec.ts$' 1
run_browser recovery-m1 tests/pr140-release/playwright.config.ts m1-recovery.spec.ts 2
node --import tsx tests/pr140-release/state.ts footprint "$evidence/after-recovery.json"
cmp "$evidence/before-recovery.json" "$evidence/after-recovery.json"
[[ "$(docker exec "$app" sha256sum /var/lib/fai-crm/documents/r05-synthetic.txt | cut -d ' ' -f1)" == "$document_before" ]]
[[ "$(docker inspect -f '{{.Id}}' "$pg")" == "$pg_id" ]]
[[ "$(docker inspect -f '{{.State.StartedAt}}' "$pg")" == "$pg_started" ]]
# Qualify resuming the candidate after the same explicit session gate.
stop_app
node --import tsx tests/pr140-release/state.ts revoke-sessions > "$evidence/resume-session-revocation.json"
start_app "$candidate_id" registry controlled internal
wait_healthy
[[ "$(docker inspect -f '{{.Image}}' "$app")" == "$candidate_id" ]]
run_browser resume-m1 tests/pr140-release/playwright.config.ts m1-recovery.spec.ts 2
node --import tsx tests/pr140-release/state.ts footprint "$evidence/after-resume.json"
cmp "$evidence/before-recovery.json" "$evidence/after-resume.json"
[[ "$(docker inspect -f '{{.State.StartedAt}}' "$pg")" == "$pg_started" ]]
docker save "$candidate_image" "$recovery_image" | gzip -1 > "$evidence/release-images.tar.gz"
bundle_sha="$(sha256sum "$evidence/release-images.tar.gz" | cut -d ' ' -f1)"
printf '{"protocol":"PR140_RELEASE_R05","status":"CI_SCHEMA48_M1_APPLICATION_RETURN_PASS","synthetic":true,"candidateCommit":"%s","candidateTree":"%s","candidateImageId":"%s","recoveryCommit":"%s","recoveryTree":"%s","recoveryImageId":"%s","imageArchiveSha256":"%s","schema":48,"clientReadGrantsPreserved":true,"recoveryEnforcesClientPerimeters":true,"m1HistoryAndDocumentAccessVerified":true,"legacyRecoveryAdmitted":false,"databaseNotRestarted":true,"documentSha256":"%s","footprintUnchanged":true,"failedCandidateDetected":true,"liveSessionRestartDenied":true,"explicitSyntheticRevocationRequired":true,"resumeQualified":true,"databaseRestoreQualified":false,"productionAdmitted":false}\n' \
 "$head" "$tree" "$candidate_id" "$recovery_head" "$recovery_tree" "$recovery_id" "$bundle_sha" "$document_before" > "$evidence/release-receipt.json"
cat "$evidence/release-receipt.json"
