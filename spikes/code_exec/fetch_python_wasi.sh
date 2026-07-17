#!/usr/bin/env bash
# Fetches the pinned CPython-WASI build into vendor/ (gitignored).
# Phase 1 (SHA256 empty): downloads and prints the hash to pin.
# Phase 2 (SHA256 set): verifies the pin, then unpacks.
set -euo pipefail
cd "$(dirname "$0")"

# --- pin (fill from Step 1 discovery + Step 3 hash) ---
URL="https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.14.6/python-3.14.6-wasi_sdk-24.zip"      # asset browser_download_url from Step 1
SHA256="73bf2e9774c4d8820d0877ec5db0b963df3a9611fc2a63838aeaee29dfd034e6"   # pinned after first download
# ------------------------------------------------------

[ -n "$URL" ] || { echo "Set URL first (see plan Task 2)"; exit 1; }
mkdir -p vendor
archive="vendor/$(basename "$URL")"
[ -f "$archive" ] || curl -fL --retry 3 -o "$archive" "$URL"

actual=$(sha256sum "$archive" | cut -d' ' -f1)
if [ -z "$SHA256" ]; then
  echo "PIN THIS: SHA256=$actual"
elif [ "$actual" != "$SHA256" ]; then
  echo "HASH MISMATCH: expected $SHA256 got $actual" >&2; exit 1
fi

case "$archive" in
  *.zip) unzip -oq "$archive" -d vendor ;;
  *.tar.gz|*.tgz) tar -xzf "$archive" -C vendor ;;
  *.tar.zst) tar --zstd -xf "$archive" -C vendor ;;
esac
echo "Unpacked. Layout:"; find vendor -maxdepth 3 -name '*.wasm' -o -maxdepth 2 -type d | head -20
