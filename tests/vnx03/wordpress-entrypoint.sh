#!/usr/bin/env bash
set -Eeuo pipefail

ca_source=/run/vnx03-secrets/trusted-ca.crt
ca_target=/usr/local/share/ca-certificates/fai-vnx03-synthetic-ca.crt

if [[ ! -f "$ca_source" ]]; then
  echo 'VNX03_TRUST_ANCHOR_MISSING' >&2
  exit 70
fi

install -m 0644 "$ca_source" "$ca_target"
update-ca-certificates >/dev/null
openssl verify -CAfile "$ca_target" /run/vnx03-secrets/gateway.trusted.crt >/dev/null

exec /usr/local/bin/docker-entrypoint.sh "$@"
