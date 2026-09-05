#!/usr/bin/env bash
set -Eeuo pipefail

readonly WPFORMS_VERSION='2.0.1.1'
readonly WPFORMS_URL='https://downloads.wordpress.org/plugin/wpforms-lite.2.0.1.1.zip'
readonly WPFORMS_SHA256='6245074790df01a6e24a42587e024132b4a28fac499d1a8fa12ebf5580e4852b'
readonly WP_CLI_VERSION='2.12.0'
readonly WP_CLI_URL='https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar'
readonly WP_CLI_SHA256='ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c'
readonly COMPOSE_RELATIVE_PATH='tests/vnx03/docker-compose.yml'

fail() {
  echo "$1" >&2
  exit 1
}

if [[ "${VNX03_SYNTHETIC_E2E_CONFIRMED:-}" != '1' ]]; then
  fail 'VNX03_SYNTHETIC_CONFIRMATION_MISSING'
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

[[ "$(git rev-parse --show-toplevel)" == "$repo_root" ]] || fail 'VNX03_REPOSITORY_ROOT_INVALID'
[[ -z "$(git status --porcelain=v2 --untracked-files=no)" ]] || fail 'VNX03_TRACKED_WORKTREE_DIRTY'

source_commit="$(git rev-parse HEAD)"
source_tree="$(git rev-parse 'HEAD^{tree}')"
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'VNX03_SOURCE_COMMIT_INVALID'
[[ "$source_tree" =~ ^[0-9a-f]{40}$ ]] || fail 'VNX03_SOURCE_TREE_INVALID'

migration_count="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[[ "$migration_count" == '43' ]] || fail 'VNX03_MIGRATION_COUNT_INVALID'

if [[ -n "${VNX03_BASE_SHA:-}" ]] \
  && git cat-file -e "${VNX03_BASE_SHA}^{commit}" 2>/dev/null \
  && git diff --name-only "${VNX03_BASE_SHA}"...HEAD -- \
    tests/vnx03 tests/vnx03-e2e-harness.test.ts scripts/vnx03 \
    docs/vnx03-wpforms-https-end-to-end-qualification-r01.md \
    | grep -q .; then
  if git diff --name-only "${VNX03_BASE_SHA}"...HEAD -- \
    prisma/schema.prisma \
    prisma/migrations \
    src \
    Dockerfile.prod.example \
    docker-compose.prod.example.yml \
    .env.example \
    .env.production.example \
    .env.staging.example \
    | grep -q .; then
    fail 'VNX03_FORBIDDEN_RUNTIME_OR_SCHEMA_DELTA'
  fi
fi

docker_context="$(docker context show)"
docker_endpoint="$(docker context inspect "$docker_context" --format '{{ (index .Endpoints "docker").Host }}')"
case "$docker_endpoint" in
  unix:///var/run/docker.sock|npipe:////./pipe/docker_engine) ;;
  *) fail 'VNX03_NONLOCAL_DOCKER_CONTEXT_FORBIDDEN' ;;
esac
docker info --format '{{.ServerVersion}} {{.OSType}}' | grep -Eq '^[^ ]+ linux$' \
  || fail 'VNX03_LINUX_DOCKER_REQUIRED'

if [[ "${1:-}" == '--preflight-only' ]]; then
  echo 'VNX03_PREFLIGHT_READY'
  exit 0
fi
[[ $# -eq 0 ]] || fail 'VNX03_ARGUMENT_INVALID'

runtime_base="${RUNNER_TEMP:-/tmp}"
mkdir -p "$runtime_base"
runtime_dir="$(mktemp -d "$runtime_base/fai-vnx03.XXXXXX")"
evidence_dir="${VNX03_EVIDENCE_DIR:-$runtime_base/fai-vnx03-evidence-${source_commit:0:12}}"
mkdir -p "$evidence_dir"

project_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
project_suffix="$(printf '%s' "$project_suffix" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
export COMPOSE_PROJECT_NAME="fai-vnx03-${project_suffix}"
export VNX03_SOURCE_COMMIT="$source_commit"
export VNX03_SOURCE_TREE="$source_tree"
export VNX03_WP_PORT="${VNX03_WP_PORT:-18083}"
[[ "$VNX03_WP_PORT" =~ ^[0-9]+$ ]] || fail 'VNX03_WORDPRESS_PORT_INVALID'
(( VNX03_WP_PORT >= 1024 && VNX03_WP_PORT <= 65535 )) || fail 'VNX03_WORDPRESS_PORT_INVALID'
export VNX03_WORDPRESS_PUBLIC_URL="http://127.0.0.1:${VNX03_WP_PORT}"
export VNX03_COMPOSE_FILE="$repo_root/$COMPOSE_RELATIVE_PATH"
export VNX03_EVIDENCE_DIR="$evidence_dir"
export VNX03_DOCKER_CONTEXT="$docker_context"
export VNX03_DOCKER_ENDPOINT="$docker_endpoint"

node -e '
  const { writeFileSync } = require("node:fs");
  const output = {
    qualification: "VNX-03-SYNTHETIC",
    createdBeforeApplicationWrites: true,
    sourceCommit: process.env.VNX03_SOURCE_COMMIT,
    sourceTree: process.env.VNX03_SOURCE_TREE,
    dockerContext: process.env.VNX03_DOCKER_CONTEXT,
    dockerEndpoint: process.env.VNX03_DOCKER_ENDPOINT,
    composeProject: process.env.COMPOSE_PROJECT_NAME,
    network: `${process.env.COMPOSE_PROJECT_NAME}_vnx03`,
    databases: ["fai_vnx03_e2e", "fai_vnx03_wordpress"],
    endpoints: {
      browser: process.env.VNX03_WORDPRESS_PUBLIC_URL,
      gateway: "https://gateway.vnx03.test:8443/api/integrations/website/leads/v2",
      crm: "http://crm:3000",
      postgres: "postgres:5432",
      mysql: "mysql:3306"
    },
    runtimeNetworkInternal: true,
    productionContact: false
  };
  writeFileSync(process.argv[1], `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
' "$evidence_dir/preflight.json"

compose=(docker compose -p "$COMPOSE_PROJECT_NAME" -f "$VNX03_COMPOSE_FILE")
compose_resources_created=false
cleanup_status='NOT_CREATED'
cleanup() {
  local command_status=$?
  trap - EXIT
  set +e
  if [[ "$compose_resources_created" == true ]]; then
    if "${compose[@]}" down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1; then
      cleanup_status='REMOVED_CONTAINERS_NETWORKS_VOLUMES'
      local image_names=(
        "$COMPOSE_PROJECT_NAME-harness:$source_commit"
        "$COMPOSE_PROJECT_NAME-crm:$source_commit"
        "$COMPOSE_PROJECT_NAME-wordpress:$source_commit"
      )
      local images_to_remove=()
      local image_name
      for image_name in "${image_names[@]}"; do
        if docker image inspect "$image_name" >/dev/null 2>&1; then
          images_to_remove+=("$image_name")
        fi
      done
      if (( ${#images_to_remove[@]} > 0 )); then
        if docker image rm "${images_to_remove[@]}" >/dev/null 2>&1; then
          cleanup_status='REMOVED_CONTAINERS_NETWORKS_VOLUMES_IMAGES'
        else
          cleanup_status='FAILED_IMAGE_REMOVAL'
        fi
      fi
    else
      cleanup_status='FAILED_RESOURCE_REMOVAL'
    fi
  fi
  case "$runtime_dir" in
    "$runtime_base"/fai-vnx03.*)
      find "$runtime_dir" -depth -delete || cleanup_status='FAILED_RUNTIME_CLEANUP'
      ;;
    *) cleanup_status='FAILED_UNSAFE_RUNTIME_PATH' ;;
  esac
  node -e '
    const { writeFileSync } = require("node:fs");
    writeFileSync(process.argv[1], `${JSON.stringify({ cleanup: process.argv[2] })}\n`, { mode: 0o600 });
  ' "$evidence_dir/cleanup.json" "$cleanup_status" \
    || cleanup_status='FAILED_EVIDENCE_WRITE'
  if [[ "$command_status" -eq 0 && "$cleanup_status" == FAILED* ]]; then
    command_status=1
  fi
  exit "$command_status"
}
trap cleanup EXIT

artifacts_dir="$runtime_dir/artifacts"
wordpress_build_context="$runtime_dir/wordpress-build"
mkdir -p "$artifacts_dir" "$wordpress_build_context"

download_and_verify() {
  local url="$1"
  local output="$2"
  local digest="$3"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 180 \
    --output "$output" "$url"
  printf '%s  %s\n' "$digest" "$output" | sha256sum -c - >/dev/null
}

download_and_verify "$WPFORMS_URL" "$artifacts_dir/wpforms-lite.zip" "$WPFORMS_SHA256"
download_and_verify "$WP_CLI_URL" "$artifacts_dir/wp-cli.phar" "$WP_CLI_SHA256"
node tools/package-vnx02-wordpress-connector.mjs --output "$artifacts_dir" \
  > "$runtime_dir/connector-package.log"
connector_zip="$artifacts_dir/fai-secure-lead-connector-1.0.0.zip"
[[ -f "$connector_zip" ]] || fail 'VNX03_CONNECTOR_ZIP_MISSING'
connector_sha256="$(sha256sum "$connector_zip" | awk '{print $1}')"
[[ "$connector_sha256" =~ ^[0-9a-f]{64}$ ]] || fail 'VNX03_CONNECTOR_DIGEST_INVALID'

cp tests/vnx03/Dockerfile.wordpress "$wordpress_build_context/Dockerfile"
cp tests/vnx03/wordpress-entrypoint.sh "$wordpress_build_context/wordpress-entrypoint.sh"
cp tests/vnx03/wordpress-config.php "$wordpress_build_context/wordpress-config.php"
cp tests/vnx03/setup-wordpress.php "$wordpress_build_context/setup-wordpress.php"
cp tests/vnx03/wp-state.php "$wordpress_build_context/wp-state.php"
cp "$artifacts_dir/wpforms-lite.zip" "$wordpress_build_context/wpforms-lite.zip"
cp "$artifacts_dir/wp-cli.phar" "$wordpress_build_context/wp-cli.phar"
cp "$connector_zip" "$wordpress_build_context/fai-secure-lead-connector.zip"

export VNX03_WORDPRESS_BUILD_CONTEXT="$wordpress_build_context"
export VNX03_WPFORMS_SHA256="$WPFORMS_SHA256"
export VNX03_WP_CLI_SHA256="$WP_CLI_SHA256"
export VNX03_CONNECTOR_SHA256="$connector_sha256"
export VNX03_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export VNX03_MYSQL_PASSWORD="$(openssl rand -hex 24)"
export VNX03_MYSQL_ROOT_PASSWORD="$(openssl rand -hex 24)"
export VNX03_AUTH_SECRET="$(openssl rand -hex 32)"
export VNX03_WORDPRESS_ADMIN_PASSWORD="$(openssl rand -hex 24)"
export VNX03_WORDPRESS_AUTH_KEY="$(openssl rand -base64 48 | tr -d '\n')"
export VNX03_WORDPRESS_SECURE_AUTH_KEY="$(openssl rand -base64 48 | tr -d '\n')"
export VNX03_WORDPRESS_LOGGED_IN_KEY="$(openssl rand -base64 48 | tr -d '\n')"
export VNX03_WORDPRESS_NONCE_KEY="$(openssl rand -base64 48 | tr -d '\n')"
export VNX03_WORDPRESS_AUTH_SALT="$(openssl rand -base64 48 | tr -d '\n')"
export VNX03_WORDPRESS_SECURE_AUTH_SALT="$(openssl rand -base64 48 | tr -d '\n')"
export VNX03_WORDPRESS_LOGGED_IN_SALT="$(openssl rand -base64 48 | tr -d '\n')"
export VNX03_WORDPRESS_NONCE_SALT="$(openssl rand -base64 48 | tr -d '\n')"

"${compose[@]}" config --quiet
compose_resources_created=true
"${compose[@]}" build --pull harness crm wordpress
"${compose[@]}" up -d --wait --wait-timeout 180 postgres mysql
"${compose[@]}" run --rm -T materials bash tests/vnx03/init-materials.sh
"${compose[@]}" run --rm -T harness bash -lc \
  'npm run prisma:migrate:deploy && node --import tsx tests/vnx03/provision.ts'
"${compose[@]}" up -d --wait --wait-timeout 180 crm gateway wordpress

wp=("${compose[@]}" exec -T --user 33:33 -e HOME=/tmp wordpress wp --path=/var/www/html --quiet)
"${wp[@]}" core install \
  --url="$VNX03_WORDPRESS_PUBLIC_URL" \
  --title='FAI VNX03 Synthetic' \
  --admin_user=vnx03_synthetic_admin \
  --admin_password="$VNX03_WORDPRESS_ADMIN_PASSWORD" \
  --admin_email=admin@vnx03.invalid \
  --skip-email
"${wp[@]}" rewrite structure '/%postname%/' --hard
[[ "$("${wp[@]}" option get permalink_structure)" == '/%postname%/' ]] \
  || fail 'VNX03_WORDPRESS_REWRITE_MISMATCH'
"${wp[@]}" plugin install /opt/vnx03/wpforms-lite.zip --activate
"${wp[@]}" eval-file /opt/vnx03/setup-wordpress.php
"${wp[@]}" plugin install /opt/vnx03/fai-secure-lead-connector.zip --activate

wordpress_version="$("${wp[@]}" core version)"
wpforms_version="$("${wp[@]}" plugin get wpforms-lite --field=version)"
connector_version="$("${wp[@]}" plugin get fai-secure-lead-connector --field=version)"
[[ "$wordpress_version" == '7.1' ]] || fail 'VNX03_WORDPRESS_VERSION_MISMATCH'
[[ "$wpforms_version" == "$WPFORMS_VERSION" ]] || fail 'VNX03_WPFORMS_VERSION_MISMATCH'
[[ "$connector_version" == '1.0.0' ]] || fail 'VNX03_CONNECTOR_VERSION_MISMATCH'

export VNX03_RUNTIME_WORDPRESS_VERSION="$wordpress_version"
export VNX03_RUNTIME_WPFORMS_VERSION="$wpforms_version"
export VNX03_RUNTIME_CONNECTOR_VERSION="$connector_version"
export VNX03_RUNTIME_PHP_VERSION="$("${compose[@]}" exec -T wordpress php -r 'echo PHP_VERSION;')"
export VNX03_RUNTIME_MYSQL_VERSION="$("${compose[@]}" exec -T mysql mysql --version | tr -d '\r')"
export VNX03_RUNTIME_POSTGRES_VERSION="$("${compose[@]}" exec -T postgres postgres --version | tr -d '\r')"
export VNX03_RUNTIME_NODE_VERSION="$("${compose[@]}" run --rm -T harness node --version | tr -d '\r')"
export VNX03_RUNTIME_DOCKER_VERSION="$(docker version --format '{{.Server.Version}}')"
export VNX03_RUNTIME_COMPOSE_VERSION="$(docker compose version --short)"

npx playwright test tests/vnx03/wpforms-https-e2e.spec.ts \
  --workers=1 \
  --reporter=line \
  --output="$runtime_dir/playwright-output"

"${compose[@]}" images --format json > "$evidence_dir/images.json"
node -e '
  const { writeFileSync } = require("node:fs");
  const output = {
    qualification: "VNX-03-SYNTHETIC",
    sourceCommit: process.env.VNX03_SOURCE_COMMIT,
    sourceTree: process.env.VNX03_SOURCE_TREE,
    connectorZipSha256: process.env.VNX03_CONNECTOR_SHA256,
    wpforms: {
      version: process.env.VNX03_RUNTIME_WPFORMS_VERSION,
      sha256: process.env.VNX03_WPFORMS_SHA256,
      source: "downloads.wordpress.org"
    },
    wordpress: process.env.VNX03_RUNTIME_WORDPRESS_VERSION,
    php: process.env.VNX03_RUNTIME_PHP_VERSION,
    mysql: process.env.VNX03_RUNTIME_MYSQL_VERSION,
    postgres: process.env.VNX03_RUNTIME_POSTGRES_VERSION,
    node: process.env.VNX03_RUNTIME_NODE_VERSION,
    docker: process.env.VNX03_RUNTIME_DOCKER_VERSION,
    dockerCompose: process.env.VNX03_RUNTIME_COMPOSE_VERSION,
    migrations: 43,
    n14Enabled: false,
    externalProvidersEnabled: false,
    productionContact: false
  };
  writeFileSync(process.argv[1], `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
' "$evidence_dir/runtime.json"

[[ -z "$(git status --porcelain=v2 --untracked-files=no)" ]] \
  || fail 'VNX03_TRACKED_WORKTREE_CHANGED_DURING_TEST'

echo 'VNX03_E2E_COMPLETE'
