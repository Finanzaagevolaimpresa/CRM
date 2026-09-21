#!/usr/bin/env bash
set -euo pipefail

test "${APP_ENV:-}" = test
test "${PRACTICE_READINESS_BROWSER_CONFIRMED:-}" = 1
candidate_head="$(git rev-parse HEAD)"
old_head=c89b80678bc3ad47a24a493b488537de95d13b56
case "${1:-}" in
  search) source_path=src/app/search/page.tsx; marker=DOSSIER_SEARCH_DENIAL_sensitive ;;
  report) source_path=src/lib/operational-report.ts; marker=DOSSIER_REPORT_DENIAL_sensitive ;;
  *) echo "Expected search or report" >&2; exit 2 ;;
esac
evidence="$PRACTICE_READINESS_BROWSER_EVIDENCE_DIR/counterfactual-$1"
mkdir -p "$evidence"
test "$APP_ORIGIN" = http://127.0.0.1:3000
curl --fail --silent --max-time 5 "$APP_ORIGIN/api/health" >/dev/null
git diff --quiet -- "$source_path"
# Keep the already-qualified dev server alive. Next recompiles this one reader
# on request; restore its exact committed bytes even if the counterproof fails.
trap 'git show "$candidate_head:$source_path" > "$source_path"' EXIT
git show "$old_head:$source_path" > "$source_path"
set +e
PRACTICE_READINESS_BROWSER_EVIDENCE_DIR="$evidence" \
  PLAYWRIGHT_JSON_OUTPUT_NAME="$evidence/playwright.json" \
  npx playwright test --config tests/practice-readiness-browser/playwright.config.ts \
  --grep '^versioned dossier listings follow current detail access$' --reporter=line,json \
  --output "$evidence/test-results" > "$evidence/playwright.log" 2>&1
probe_status=$?
set -e
test "$probe_status" -ne 0
node - "$evidence/playwright.json" "$marker" "$candidate_head" "$old_head" "$source_path" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [file, marker, candidateHead, oldHead, sourcePath] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(report.stats.expected, 0);
assert.equal(report.stats.unexpected, 1);
assert.equal(report.stats.skipped, 0);
const specs = (suites) => suites.flatMap(suite => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]);
const errors = specs(report.suites).flatMap(spec => spec.tests.flatMap(test => test.results.flatMap(result => result.errors ?? [])));
const normalized = errors.map(error => String(error.message ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim().replace(/^Error:\s*/, ''));
assert.ok(normalized.some(message => message.startsWith(marker + '\n')), 'The old reader must fail at its precise disclosure assertion');
const evidence = { candidateHead, oldHead, sourcePath, expectedDefectDetected: true, assertion: marker, synthetic: true };
fs.writeFileSync(file.replace('playwright.json', 'detected.json'), JSON.stringify(evidence) + '\n');
console.log(JSON.stringify(evidence));
NODE
