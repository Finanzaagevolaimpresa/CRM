#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${VNX03_MATERIALS_CONFIRMED:-}" != '1' ]]; then
  echo 'VNX03_MATERIALS_CONFIRMATION_MISSING' >&2
  exit 64
fi

node tests/vnx03/init-materials.mjs

secret_root=/run/secrets
umask 077

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$secret_root/trusted-ca.key" >/dev/null 2>&1
openssl req -x509 -new -sha256 -days 2 \
  -key "$secret_root/trusted-ca.key" \
  -subj '/CN=FAI VNX03 Synthetic Trusted Root' \
  -out "$secret_root/trusted-ca.crt" >/dev/null 2>&1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$secret_root/gateway.trusted.key" >/dev/null 2>&1
openssl req -new -sha256 \
  -key "$secret_root/gateway.trusted.key" \
  -subj '/CN=gateway.vnx03.test' \
  -addext 'subjectAltName=DNS:gateway.vnx03.test' \
  -out "$secret_root/gateway.trusted.csr" >/dev/null 2>&1
openssl x509 -req -sha256 -days 2 \
  -in "$secret_root/gateway.trusted.csr" \
  -CA "$secret_root/trusted-ca.crt" \
  -CAkey "$secret_root/trusted-ca.key" \
  -CAcreateserial \
  -copy_extensions copy \
  -out "$secret_root/gateway.trusted.crt" >/dev/null 2>&1

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$secret_root/untrusted-ca.key" >/dev/null 2>&1
openssl req -x509 -new -sha256 -days 2 \
  -key "$secret_root/untrusted-ca.key" \
  -subj '/CN=FAI VNX03 Synthetic Untrusted Root' \
  -out "$secret_root/untrusted-ca.crt" >/dev/null 2>&1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$secret_root/gateway.untrusted.key" >/dev/null 2>&1
openssl req -new -sha256 \
  -key "$secret_root/gateway.untrusted.key" \
  -subj '/CN=untrusted-gateway.vnx03.test' \
  -addext 'subjectAltName=DNS:untrusted-gateway.vnx03.test' \
  -out "$secret_root/gateway.untrusted.csr" >/dev/null 2>&1
openssl x509 -req -sha256 -days 2 \
  -in "$secret_root/gateway.untrusted.csr" \
  -CA "$secret_root/untrusted-ca.crt" \
  -CAkey "$secret_root/untrusted-ca.key" \
  -CAcreateserial \
  -copy_extensions copy \
  -out "$secret_root/gateway.untrusted.crt" >/dev/null 2>&1

chmod 0600 "$secret_root"/*.key "$secret_root"/*.csr "$secret_root"/*.srl
chmod 0644 "$secret_root"/*.crt
chown 1000:1000 \
  "$secret_root/gateway.trusted.key" \
  "$secret_root/gateway.trusted.crt" \
  "$secret_root/gateway.untrusted.key" \
  "$secret_root/gateway.untrusted.crt"

openssl verify -CAfile "$secret_root/trusted-ca.crt" \
  -verify_hostname gateway.vnx03.test \
  "$secret_root/gateway.trusted.crt" >/dev/null
if openssl verify -CAfile "$secret_root/trusted-ca.crt" \
  -verify_hostname wrong-host.vnx03.test \
  "$secret_root/gateway.trusted.crt" >/dev/null 2>&1; then
  echo 'VNX03_HOSTNAME_NEGATIVE_CONTROL_FAILED' >&2
  exit 1
fi
if openssl verify -CAfile "$secret_root/trusted-ca.crt" \
  -verify_hostname untrusted-gateway.vnx03.test \
  "$secret_root/gateway.untrusted.crt" >/dev/null 2>&1; then
  echo 'VNX03_CA_NEGATIVE_CONTROL_FAILED' >&2
  exit 1
fi

echo 'VNX03_TLS_MATERIALS_READY'
