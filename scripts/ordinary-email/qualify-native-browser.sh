#!/usr/bin/env bash
set -Eeuo pipefail
test "${CI:-}" = true
test "${ORDINARY_EMAIL_BROWSER_CONFIRMED:-}" = 1
test "${APP_ENV:-}" = test
test "${NODE_ENV:-}" = development
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
[[ "${ORDINARY_BROWSER_DB_CONTAINER:-}" =~ ^[a-f0-9]{64}$ ]]
prefix="ordinary-ui-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
network="$prefix-net"; app="$prefix-app"; app_forwarder=''
image='node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d'
secrets="$RUNNER_TEMP/ordinary-secrets"; control="$RUNNER_TEMP/ordinary-control"
export ORDINARY_EMAIL_BROWSER_EVIDENCE="$RUNNER_TEMP/ordinary-email"
export LOCAL_DOCUMENT_STORAGE_ROOT="$RUNNER_TEMP/ordinary-browser-documents"
export ORDINARY_EMAIL_TLS_CONTROL="$control"
umask 077
mkdir -p "$secrets" "$control" "$ORDINARY_EMAIL_BROWSER_EVIDENCE" "$LOCAL_DOCUMENT_STORAGE_ROOT"
for name in ORDINARY_EMAIL_BROWSER_PASSWORD PRIVILEGED_STEP_UP_SECRET DIRECT_EMAIL_TEST_SMTP_PASSWORD; do
  value="$(openssl rand -hex 32)"
  echo "::add-mask::$value"
  export "$name=$value"
done
export DIRECT_EMAIL_TEST_MODE=enforced
export DIRECT_EMAIL_TEST_REFERENCE=R49_EMAIL_DIRECT_20260930_01
export DIRECT_EMAIL_TEST_SMTP_HOST=authsmtp.securemail.pro
export DATABASE_URL='postgresql://postgres:synthetic-ordinary-browser-only@127.0.0.1:5433/fai_crm_test?schema=public'
npm run prisma:migrate:deploy
psql "${DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 -c "COMMENT ON DATABASE fai_crm_test IS 'FAI_CRM_EPHEMERAL_TEST_ONLY_V1'"
test "$(psql "${DATABASE_URL%%\?*}" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 68
test "$(psql "${DATABASE_URL%%\?*}" -Atc 'SELECT count(*) FROM "OrdinaryEmailAuthority"')" = 0
test "$(psql "${DATABASE_URL%%\?*}" -Atc 'SELECT count(*) FROM "OrdinaryEmailInboundStream"')" = 0
test "$(psql "${DATABASE_URL%%\?*}" -Atc 'SELECT count(*) FROM "InternalSession"')" = 0
test "$(psql "${DATABASE_URL%%\?*}" -Atc 'SELECT count(*) FROM "User"')" = 0
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Synthetic Ordinary CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$secrets/ca.key" -out "$secrets/ca.crt" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=authsmtp.securemail.pro' \
  -keyout "$secrets/server.key" -out "$secrets/server.csr" 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:authsmtp.securemail.pro' 'basicConstraints=critical,CA:FALSE' 'extendedKeyUsage=serverAuth' > "$secrets/server.ext"
openssl x509 -req -days 1 -in "$secrets/server.csr" -CA "$secrets/ca.crt" -CAkey "$secrets/ca.key" \
  -CAcreateserial -extfile "$secrets/server.ext" -out "$secrets/server.crt" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Unrelated Synthetic CA' \
  -keyout "$secrets/unrelated.key" -out "$secrets/unrelated.crt" 2>/dev/null
printf accept > "$control/mode"
docker pull "$image" >/dev/null
cleanup() {
  local result=$?
  # Next development logs include action arguments. Keep raw output alongside
  # ephemeral secrets, outside artifacts; emit only a fixed diagnostic summary.
  docker logs "$app" > "$secrets/app.log" 2>&1 || true
  node scripts/ordinary-email/summarize-ci-app-log.mjs "$secrets/app.log" > "$ORDINARY_EMAIL_BROWSER_EVIDENCE/app-summary.json" || true
  if [[ "$result" != 0 ]]; then cat "$ORDINARY_EMAIL_BROWSER_EVIDENCE/app-summary.json" || true; fi
  if [[ -n "$app_forwarder" ]]; then kill "$app_forwarder" 2>/dev/null || true; wait "$app_forwarder" 2>/dev/null || true; fi
  docker rm -f "$app" >/dev/null 2>&1 || true
  docker network disconnect "$network" "$ORDINARY_BROWSER_DB_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal --label fai.synthetic=ordinary-email "$network" >/dev/null
docker network connect --alias ordinary-browser-db "$network" "$ORDINARY_BROWSER_DB_CONTAINER"
docker run -d --name "$app" --network "$network" --network-alias authsmtp.securemail.pro \
  --user "$(id -u):$(id -g)" --sysctl net.ipv4.ip_unprivileged_port_start=0 --cap-drop ALL --security-opt no-new-privileges=true --env HOME=/tmp \
  --workdir "$GITHUB_WORKSPACE" \
  --mount "type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE" \
  --mount "type=bind,src=$secrets,dst=/run/ordinary-secrets,readonly" \
  --mount "type=bind,src=$control,dst=/run/ordinary-control,readonly" \
  --mount "type=bind,src=$ORDINARY_EMAIL_BROWSER_EVIDENCE,dst=$ORDINARY_EMAIL_BROWSER_EVIDENCE" \
  --mount "type=bind,src=$LOCAL_DOCUMENT_STORAGE_ROOT,dst=$LOCAL_DOCUMENT_STORAGE_ROOT" \
  --env CI --env APP_ENV --env NODE_ENV --env AUTH_SECRET --env AUTH_COOKIE_NAME --env APP_ORIGIN \
  --env INTERNAL_SESSION_MODE --env PRIVILEGED_ACCESS_MODE --env PRIVILEGED_STEP_UP_KEY_VERSION \
  --env PRIVILEGED_STEP_UP_SECRET --env LOGIN_THROTTLE_MODE --env COMMERCIAL_LEAD_INBOX_MODE \
  --env ORDINARY_EMAIL_BROWSER_CONFIRMED --env ORDINARY_EMAIL_BROWSER_EVIDENCE --env LOCAL_DOCUMENT_STORAGE_ROOT \
  --env DIRECT_EMAIL_TEST_MODE --env DIRECT_EMAIL_TEST_REFERENCE --env DIRECT_EMAIL_TEST_SMTP_HOST --env DIRECT_EMAIL_TEST_SMTP_PASSWORD \
  --env NODE_EXTRA_CA_CERTS=/run/ordinary-secrets/ca.crt --env NEXT_TELEMETRY_DISABLED=1 \
  --env 'DATABASE_URL=postgresql://postgres:synthetic-ordinary-browser-only@ordinary-browser-db:5432/fai_crm_test?schema=public' \
  "$image" bash -c 'node tests/ordinary-email/synthetic-tls-server.mjs & smtp=$!; trap "kill $smtp 2>/dev/null || true" EXIT; npm run dev -- --hostname 0.0.0.0 --port 3036' >/dev/null
test "$(docker network inspect "$network" --format '{{.Internal}}')" = true
test "$(docker inspect "$app" --format '{{len .NetworkSettings.Networks}}')" = 1
test "$(docker inspect "$app" --format "{{with index .NetworkSettings.Networks \"$network\"}}{{.NetworkID}}{{end}}")" = "$(docker network inspect "$network" --format '{{.Id}}')"
test "$(docker network inspect "$network" --format '{{.EnableIPv6}}')" = false
docker exec "$app" node tests/ordinary-email/network-boundary-probe.mjs
# Internal Docker networks do not publish NAT ports. A loopback-only host
# forwarder reaches the already verified internal interface without adding egress.
app_ip="$(docker inspect "$app" --format "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}")"
node scripts/ordinary-email/ci-loopback-forwarder.mjs "$app_ip" &
app_forwarder=$!
ready=0
for attempt in $(seq 1 90); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3036/api/health >/dev/null; then ready=1; break; fi
  test "$(docker inspect "$app" --format '{{.State.Running}}')" = true
  kill -0 "$app_forwarder"
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  docker exec "$app" node -e 'fetch("http://127.0.0.1:3036/api/health").then(r=>console.log("ORDINARY_INTERNAL_HEALTH",r.status)).catch(e=>console.log("ORDINARY_INTERNAL_HEALTH_ERROR",e.cause?.code??e.name))' || true
  exit 1
fi
docker exec "$app" node tests/ordinary-email/tls-boundary-probe.mjs
browser_status=0
for spec in native-ui.spec.ts native-inbound.spec.ts native-contexts.spec.ts native-send.spec.ts; do
  if ! npx playwright test --config tests/ordinary-email/playwright.config.ts "$spec"; then
    browser_status=1
  fi
done
test "$browser_status" -eq 0
test -s "$ORDINARY_EMAIL_BROWSER_EVIDENCE/native-ui-proof.json"
test -s "$ORDINARY_EMAIL_BROWSER_EVIDENCE/native-send-proof.json"
test -s "$ORDINARY_EMAIL_BROWSER_EVIDENCE/native-inbound-proof.json"
test -s "$ORDINARY_EMAIL_BROWSER_EVIDENCE/native-context-proof.json"
