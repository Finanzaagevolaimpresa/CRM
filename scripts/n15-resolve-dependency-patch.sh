#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'N15_DEPENDENCY_PATCH_ERROR|code=%s\n' "$1" >&2
  exit 1
}

[[ "${N15_DEPENDENCY_PATCH_CONFIRMED:-}" == '1' ]] || fail CONFIRMATION_REQUIRED
[[ "${N15_DEPENDENCY_PATCH_BASE_SHA:-}" == 'f48475a748315d1d8d9722412207f41b8890ad10' ]] \
  || fail BASE_IDENTITY_INVALID
[[ "$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == '44' ]] \
  || fail CANDIDATE_MIGRATION_COUNT_INVALID

work="$(mktemp -d /tmp/fai-crm-n15-dependency-patch.XXXXXX)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/original" "$work/result"
cp package.json package-lock.json "$work/original/"
cp package.json package-lock.json "$work/result/"

node - "$work/result/package.json" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const value = JSON.parse(fs.readFileSync(path, 'utf8'));
if (value.dependencies?.next !== '16.3.0'
  || value.devDependencies?.['eslint-config-next'] !== '16.3.0'
  || Object.hasOwn(value.dependencies ?? {}, 'sharp')
  || Object.hasOwn(value.dependencies ?? {}, 'js-yaml')
  || Object.hasOwn(value.devDependencies ?? {}, 'sharp')
  || Object.hasOwn(value.devDependencies ?? {}, 'js-yaml')) process.exit(1);
value.dependencies.next = '16.3.4';
value.devDependencies['eslint-config-next'] = '16.3.4';
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
NODE

(
  cd "$work/result"
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
    --registry=https://registry.npmjs.org/ --fetch-retries=2 \
    --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=3000 --fetch-timeout=30000
  npm update sharp@0.35.4 js-yaml@4.3.2 --package-lock-only --ignore-scripts \
    --no-save --no-audit --no-fund --registry=https://registry.npmjs.org/ \
    --fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=3000 --fetch-timeout=30000
)

node - "$work/original/package.json" "$work/result/package.json" "$work/result/package-lock.json" <<'NODE'
const fs = require('node:fs');
const [originalPath, resultPath, lockPath] = process.argv.slice(2);
const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const expected = structuredClone(original);
expected.dependencies.next = '16.3.4';
expected.devDependencies['eslint-config-next'] = '16.3.4';
if (JSON.stringify(result) !== JSON.stringify(expected)) process.exit(1);
if (JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(result.dependencies)
  || JSON.stringify(lock.packages?.['']?.devDependencies) !== JSON.stringify(result.devDependencies)) process.exit(1);
const observed = new Map();
for (const [path, item] of Object.entries(lock.packages ?? {})) {
  if (!path.includes('node_modules/') || !item || typeof item !== 'object') continue;
  if (item.link === true || typeof item.resolved !== 'string'
    || typeof item.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity)) process.exit(1);
  const url = new URL(item.resolved);
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password) process.exit(1);
  const tail = path.slice(path.lastIndexOf('node_modules/') + 13);
  const name = tail.startsWith('@') ? tail.split('/').slice(0, 2).join('/') : tail.split('/')[0];
  if (name.startsWith('@next/') && item.version !== '16.3.4') process.exit(1);
  if (['next', 'eslint-config-next', 'sharp', 'js-yaml'].includes(name)) {
    const versions = observed.get(name) ?? new Set(); versions.add(item.version); observed.set(name, versions);
  }
}
for (const [name, version] of Object.entries({ next: '16.3.4', 'eslint-config-next': '16.3.4', sharp: '0.35.4', 'js-yaml': '4.3.2' })) {
  const versions = [...(observed.get(name) ?? [])];
  if (versions.length !== 1 || versions[0] !== version) process.exit(1);
}
NODE

diff_file="$work/dependency.patch"
{
  diff -u --label a/package.json --label b/package.json "$work/original/package.json" "$work/result/package.json" || [[ $? == 1 ]]
  diff -u --label a/package-lock.json --label b/package-lock.json "$work/original/package-lock.json" "$work/result/package-lock.json" || [[ $? == 1 ]]
} > "$diff_file"
diff_bytes="$(wc -c < "$diff_file" | tr -d ' ')"
(( diff_bytes > 0 && diff_bytes <= 131072 )) || fail DIFF_SIZE_INVALID

printf 'N15_DEPENDENCY_PATCH_METADATA|original_package_sha256=%s|result_package_sha256=%s|original_lock_sha256=%s|result_lock_sha256=%s|diff_sha256=%s|diff_bytes=%s|registry=registry.npmjs.org|scripts=disabled\n' \
  "$(sha256sum "$work/original/package.json" | cut -d ' ' -f1)" \
  "$(sha256sum "$work/result/package.json" | cut -d ' ' -f1)" \
  "$(sha256sum "$work/original/package-lock.json" | cut -d ' ' -f1)" \
  "$(sha256sum "$work/result/package-lock.json" | cut -d ' ' -f1)" \
  "$(sha256sum "$diff_file" | cut -d ' ' -f1)" "$diff_bytes"
printf 'N15_DEPENDENCY_PATCH_BEGIN\n'
base64 -w 76 "$diff_file"
printf 'N15_DEPENDENCY_PATCH_END\n'
