#!/usr/bin/env bash

# Only ephemeral fixture material. Native Windows OpenSSL emits CRLF, which a
# password input removes while bcrypt hashes it verbatim. Normalize framing at
# the generator boundary, before either Compose or the browser receives it.
vnx03_export_synthetic_secret() {
  local name="${1:-}" encoding="${2:-}" bytes="${3:-}" value
  [[ "$#" == 3 && "$name" =~ ^VNX03_[A-Z_]+$ ]] || return 1
  case "$encoding:$bytes" in
    hex:24|hex:32|base64:32|base64:48) ;;
    *) return 1 ;;
  esac
  value="$(openssl rand "-$encoding" "$bytes")" || return 1
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  case "$encoding:$bytes" in
    hex:*) [[ "$value" =~ ^[0-9a-f]+$ && "${#value}" -eq "$((bytes * 2))" ]] || return 1 ;;
    base64:32) [[ "$value" =~ ^[A-Za-z0-9+/]{43}=$ ]] || return 1 ;;
    base64:48) [[ "$value" =~ ^[A-Za-z0-9+/]{64}$ ]] || return 1 ;;
  esac
  export "$name=$value"
}
