#!/usr/bin/env bash
# Fetches the pinned CPython-WASI build into vendor/ (gitignored).
# Phase 1 (SHA256 empty): downloads and prints the hash to pin.
# Phase 2 (SHA256 set): verifies the pin, then unpacks.
#
# Idempotent: a re-run with the guest already unpacked exits 0 immediately.
# `pixi run -e api <anything>` calls this through scripts/ensure_guest.sh, so
# the no-op path is the common one -- pass --force to re-fetch anyway (e.g. to
# re-verify the pin after changing URL/SHA256).
set -euo pipefail
cd "$(dirname "$0")"

# --- pin (fill from Step 1 discovery + Step 3 hash) ---
URL="https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.14.6/python-3.14.6-wasi_sdk-24.zip"      # asset browser_download_url from Step 1
SHA256="73bf2e9774c4d8820d0877ec5db0b963df3a9611fc2a63838aeaee29dfd034e6"   # pinned after first download
# ------------------------------------------------------

force=""
[ "${1:-}" = "--force" ] && force=1

if [ -z "$force" ] && [ -f vendor/python.wasm ] && [ -d vendor/lib/python3.14 ]; then
  echo "Guest already vendored (vendor/python.wasm + vendor/lib/python3.14); nothing to do."
  exit 0
fi

[ -n "$URL" ] || { echo "Set URL first (see plan Task 2)"; exit 1; }
for tool in curl unzip sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

mkdir -p vendor
archive="vendor/$(basename "$URL")"

# Download to a PID-unique temp name and rename into place, so an interrupted
# curl can never leave a truncated file cached as the archive. That in turn is
# what lets the hash check below KEEP a mismatching archive instead of deleting
# it: a mismatch can then only mean a genuinely stale pin, and failing fast
# beats re-downloading 14 MB on every subsequent pixi activation.
if [ ! -f "$archive" ]; then
  part="$archive.part.$$"
  trap 'rm -f "$part"' EXIT INT TERM
  curl -fL --retry 3 -o "$part" "$URL"
  mv -f "$part" "$archive"
  trap - EXIT INT TERM
fi

actual=$(sha256sum "$archive" | cut -d' ' -f1)
if [ -z "$SHA256" ]; then
  echo "PIN THIS: SHA256=$actual"
elif [ "$actual" != "$SHA256" ]; then
  echo "HASH MISMATCH: expected $SHA256 got $actual" >&2
  echo "(delete $archive to force a re-download)" >&2
  exit 1
fi

# Unpack into a scratch dir and move the pieces in, rather than unzipping over
# vendor/ directly: an interrupted in-place unzip leaves python.wasm next to a
# half-written stdlib, which scripts/ensure_guest.sh's guard reads as "done".
# Ordering below is load-bearing -- python.wasm is removed first and restored
# last, so its presence always implies a complete lib/.
work="vendor/.unpack.$$"
rm -rf "$work"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT INT TERM

case "$archive" in
  *.zip) unzip -oq "$archive" -d "$work" ;;
  *.tar.gz|*.tgz) tar -xzf "$archive" -C "$work" ;;
  *.tar.zst) tar --zstd -xf "$archive" -C "$work" ;;
esac

rm -f vendor/python.wasm
rm -rf vendor/lib
mv "$work/lib" vendor/lib
if [ -e "$work/LICENSE" ]; then
  mv -f "$work/LICENSE" vendor/LICENSE
fi
mv -f "$work/python.wasm" vendor/python.wasm

rm -rf "$work"
trap - EXIT INT TERM

echo "Unpacked. Layout:"; find vendor -maxdepth 3 -name '*.wasm' -o -maxdepth 2 -type d | head -20
