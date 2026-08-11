#!/usr/bin/env bash
# scripts/apply-rgr-yaml-patch.sh
#
# Idempotent patcher for the upstream YAML parsing bug:
#   packages/ragmir-core/src/parsing.ts:86 uses YAML.parse() which fails
#   on multi-document YAML (Hugo/Jekyll-style frontmatter).
#
# See https://github.com/jcode-works/jcode-ragmir/issues/159
#
# What this script does:
#   1. Locates the installed rgr (via $RGR_BIN or `command -v rgr`).
#   2. Resolves the symlink to the package install dir.
#   3. Locates dist/parsing.js.
#   4. Checks if the fixed form is already present (idempotent).
#   5. If not, makes a one-time timestamped backup and applies the
#      multi-line sed replacement:
#          YAML.parse(...)  →  YAML.parseAllDocuments(...) + map+join
#   6. Verifies the patch via grep counts.
#
# Run this script:
#   - once now, to fix the currently-installed rgr,
#   - after any `npm i -g @jcode.labs/ragmir` / `pnpm rebuild` / upgrade
#     that touches the rgr global install and may have overwritten the fix.
#
# Usage:
#   scripts/apply-rgr-yaml-patch.sh                       # patch global rgr
#   RGR_BIN=/path/to/rgr scripts/apply-rgr-yaml-patch.sh # explicit binary
#
# Exit codes:
#   0 — already patched, or patch applied cleanly and verified.
#   1 — patching failed (verification mismatch, raw line not found).
#   2 — rgr not found / parsing.js missing (set RGR_BIN or install rgr).

set -u

RGR_BIN="${RGR_BIN:-$(command -v rgr 2>/dev/null || true)}"
if [ -z "${RGR_BIN}" ]; then
  for candidate in /usr/local/node22/bin/rgr /usr/local/bin/rgr /usr/bin/rgr; do
    if [ -x "${candidate}" ]; then
      RGR_BIN="${candidate}"
      break
    fi
  done
fi

if [ -z "${RGR_BIN}" ]; then
  printf 'ERROR: rgr not found on PATH or in known locations.\n' >&2
  printf '       Install @jcode.labs/ragmir globally, or set RGR_BIN.\n' >&2
  exit 2
fi

RGR_REAL=$(readlink -f "${RGR_BIN}")
RGR_PKG_DIR=$(dirname "$(dirname "${RGR_REAL}")")
PARSING_JS="${RGR_PKG_DIR}/dist/parsing.js"

if [ ! -f "${PARSING_JS}" ]; then
  printf 'ERROR: dist/parsing.js not found at %s\n' "${PARSING_JS}" >&2
  printf '       RGR_BIN resolved to package dir %s\n' "${RGR_PKG_DIR}" >&2
  printf '       Set RGR_BIN to point at the correct rgr binary.\n' >&2
  exit 2
fi

printf 'Target: %s\n' "${PARSING_JS}"

GUARD_MARKER='YAML.parseAllDocuments(await readFile(file.absolutePath, "utf8"))'
RAW_LINE='            text = YAML.stringify(YAML.parse(await readFile(file.absolutePath, "utf8")));'

if grep -Fq "${GUARD_MARKER}" "${PARSING_JS}"; then
  printf 'OK: already patched (guard marker present).\n'
  exit 0
fi

if ! grep -Fq "${RAW_LINE}" "${PARSING_JS}"; then
  printf 'ERROR: expected raw line not found in %s\n' "${PARSING_JS}" >&2
  printf '       Either upstream refactored the parser (patch no longer applies)\n' >&2
  printf '       or this file has been modified beyond recognition.\n' >&2
  printf '       Inspect manually and update this script.\n' >&2
  exit 1
fi

BAK_PREFIX="${PARSING_JS}.bak"
if ls "${BAK_PREFIX}".* >/dev/null 2>&1; then
  LATEST_BAK=$(ls -t "${BAK_PREFIX}".* 2>/dev/null | head -1)
  printf 'Backup already exists: %s (skipping new backup)\n' "${LATEST_BAK}"
else
  TS=$(date +%Y%m%d-%H%M%S)
  NEW_BAK="${BAK_PREFIX}.${TS}"
  cp "${PARSING_JS}" "${NEW_BAK}"
  printf 'Backup created: %s\n' "${NEW_BAK}"
fi

sed -i 's|            text = YAML\.stringify(YAML\.parse(await readFile(file\.absolutePath, "utf8")));|            const docs = YAML.parseAllDocuments(await readFile(file.absolutePath, "utf8"));\n            text = docs.map((d) => YAML.stringify(d)).join("\\n");|' "${PARSING_JS}"

GUARD_COUNT=$(grep -cF "${GUARD_MARKER}" "${PARSING_JS}" || true)
RAW_COUNT=$(grep -cF "${RAW_LINE}" "${PARSING_JS}" || true)

if [ "${GUARD_COUNT}" -eq 1 ] && [ "${RAW_COUNT}" -eq 0 ]; then
  printf 'OK: patch applied. guard=%s, raw=%s\n' "${GUARD_COUNT}" "${RAW_COUNT}"
  exit 0
fi

printf 'ERROR: patch verification failed. guard=%s, raw=%s\n' "${GUARD_COUNT}" "${RAW_COUNT}" >&2
printf '       Restore from backup and inspect %s manually.\n' "${PARSING_JS}" >&2
exit 1
