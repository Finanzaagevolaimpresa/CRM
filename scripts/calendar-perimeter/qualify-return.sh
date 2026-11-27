#!/usr/bin/env bash
# Sourced only inside the existing isolated PR140 Docker qualification.
[[ "${BASH_SOURCE[0]}" != "$0" && "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true ]]
[[ "$(hostname)" != fai-crm-prod-02 && "${GITHUB_REPOSITORY:-}" == Finanzaagevolaimpresa/CRM ]]
declare -F stop_app start_app wait_healthy >/dev/null
[[ -d "${CALENDAR_RETURN_ARTIFACT_DIR:?}" && -d "$evidence" ]]
[[ "$head" != 5055b107fed3d35d2a62e5cad273bd60a1c1f884 ]]
[[ "$(docker inspect -f '{{.Image}}' "$app")" == "$candidate_id" ]]
export R05_EVIDENCE_DIR="$evidence"
export CALENDAR_RETURN_PRIVATE_FILE="$RUNNER_TEMP/$prefix-calendar-return-private.json"
export CALENDAR_RETURN_CANDIDATE_COMMIT="$head" CALENDAR_RETURN_CANDIDATE_TREE="$tree"
export CALENDAR_RETURN_CANDIDATE_IMAGE_ID="$candidate_id"
[[ ! -e "$CALENDAR_RETURN_PRIVATE_FILE" && ! -e "$CALENDAR_RETURN_PRIVATE_FILE.artifact.json" ]]

# The official previous artifact is downloaded by immutable artifact/run IDs.
# Check its original archive bytes and receipt before Docker sees the archive.
node --import tsx tests/personal-calendar/return-state.ts archive
docker load --input "$CALENDAR_RETURN_ARTIFACT_DIR/release-images.tar.gz" > "$evidence/calendar-return-load.log"
calendar_return_image='sha256:bdb93253dc3c725a144b280040eed704f6671da602b7e30d50d791f3076ab7e2'
[[ "$(docker image inspect -f '{{.Id}}' "$calendar_return_image")" == "$calendar_return_image" ]]
[[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$calendar_return_image")" == 5055b107fed3d35d2a62e5cad273bd60a1c1f884 ]]
[[ "$(docker image inspect -f '{{index .Config.Labels "it.finanzaagevolaimpresa.source-tree"}}' "$calendar_return_image")" == ec07c32529e86869c877cf57b3542fb68a3fd736 ]]
# Loading the historical pair can reuse a historical compatibility tag. Restore
# only these two tags owned by this qualification; image IDs remain immutable.
docker tag "$candidate_id" "$candidate_image"
docker tag "$recovery_id" "$recovery_image"
[[ "$(docker image inspect -f '{{.Id}}' "$candidate_image")" == "$candidate_id" ]]
[[ "$(docker image inspect -f '{{.Id}}' "$recovery_image")" == "$recovery_id" ]]

calendar_documents_digest() {
  docker exec -i "$app" node - <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = '/var/lib/fai-crm/documents', entries = []; let total = 0;
function visit(relative) {
  const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw Error('CALENDAR_RETURN_DOCUMENT_LINK_DENIED');
  if (stat.isDirectory()) {
    entries.push([relative, 'directory']);
    for (const name of fs.readdirSync(absolute).sort()) visit(path.posix.join(relative, name));
  } else {
    if (!stat.isFile() || stat.size > 64 * 1024 ** 2 || (total += stat.size) > 512 * 1024 ** 2) throw Error('CALENDAR_RETURN_DOCUMENT_SCOPE');
    entries.push([relative, 'file', stat.size, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
  }
}
visit('');
process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'));
NODE
}
calendar_return_documents="$(calendar_documents_digest)"
[[ "$calendar_return_documents" =~ ^[a-f0-9]{64}$ ]]
export CALENDAR_RETURN_DATABASE_ID="$pg_id" CALENDAR_RETURN_DATABASE_STARTED="$pg_started"

calendar_return_probe() {
  local phase="$1"
  [[ "$(docker inspect -f '{{.Id}}' "$pg")" == "$pg_id" ]]
  [[ "$(docker inspect -f '{{.State.StartedAt}}' "$pg")" == "$pg_started" ]]
  export CALENDAR_RETURN_DOCUMENT_SHA="$(calendar_documents_digest)"
  [[ "$CALENDAR_RETURN_DOCUMENT_SHA" == "$calendar_return_documents" ]]
  # Secrets are read only through this private pipe, checked in memory and never
  # written to the minimized proof or the uploaded artifact.
  docker inspect -f '{"imageId":{{json .Image}},"environment":{{json .Config.Env}}}' "$app" |
    node --import tsx tests/personal-calendar/return-state.ts probe "$phase"
}

# Separate from the earlier intentional-revocation scenario: this append-only
# synthetic receipt authorizes registry continuity, and both cookies stay live.
node --import tsx tests/personal-calendar/return-state.ts prepare
calendar_return_probe candidate-before
stop_app
start_app "$calendar_return_image" registry controlled internal
wait_healthy
calendar_return_probe pr263-return
stop_app
start_app "$candidate_id" registry controlled internal
wait_healthy
calendar_return_probe candidate-resumed
node --import tsx tests/personal-calendar/return-state.ts finish "$evidence/calendar-return-summary.json"
