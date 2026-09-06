#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# A separate, explicitly opted-in configuration gate; the release gate and the
# ordinary legacy switch retain their existing image/source identity contract.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/key_mounts.py" "$@"
