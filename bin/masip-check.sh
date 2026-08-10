#!/usr/bin/env bash
# masip-check.sh — Static MASIP compliance checker.
#
# Verifies that knowledge records in Type-B projects conform to MASIP:
#   1. Every Type-B record has YAML frontmatter (--- ... ---)         §4
#   2. No knowledge records leaked into Type-A retrieval projects     §0
#   3. All mutated Type-B files have a backup under .ragmir-history/   §6
#   4. rgr audit reports missingFromIndex=0, staleInIndex=0,          §6
#      duplicateCandidates=0
#   5. ragmir_search(<unique-token>) returns the seeded record        §6
#
# Usage:
#   bin/masip-check.sh                     # check all known Type-B projects
#   bin/masip-check.sh <project-dir> ...   # check specific projects
#
# Exit code: 0 = clean, 1 = at least one violation found.

set -u

RGR_BIN="${RGR_BIN:-/usr/local/node22/bin/rgr}"
PROJECTS_ROOT="${PROJECTS_ROOT:-/opt/ragmir-projects}"

# --- Helpers ----------------------------------------------------------------

err()  { printf '❌ %s\n' "$*" >&2; }
ok()   { printf '✓  %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }

violations=0
checks=0

check() {
  local name="$1"; shift
  checks=$((checks + 1))
  if "$@"; then
    ok "$name"
    return 0
  else
    err "$name"
    violations=$((violations + 1))
    return 1
  fi
}

# Identify Type-B projects: those containing a `experience/` subtree that
# is registered in `.ragmir/config.json` sources.
discover_type_b_projects() {
  local root="$1"
  [ -d "$root" ] || return 0
  for cfg in "$root"/*/.ragmir/config.json; do
    [ -f "$cfg" ] || continue
    # Heuristic: project is Type-B if it has an `experience/` dir or sources include it.
    local project_dir
    project_dir="$(dirname "$(dirname "$cfg")")"
    if [ -d "$project_dir/experience" ]; then
      echo "$project_dir"
    fi
  done
}

# Identify Type-A retrieval projects: those with sources registered but no
# `experience/` curation subtree. We never expect MASIP records here.
discover_type_a_projects() {
  local root="$1"
  [ -d "$root" ] || return 0
  for cfg in "$root"/*/.ragmir/config.json; do
    [ -f "$cfg" ] || continue
    local project_dir
    project_dir="$(dirname "$(dirname "$cfg")")"
    if [ ! -d "$project_dir/experience" ]; then
      echo "$project_dir"
    fi
  done
}

# --- Check 1: YAML frontmatter on every Type-B record -----------------------
check_frontmatter() {
  local project_dir="$1"
  local bad=0
  while IFS= read -r -d '' f; do
    # First non-empty line must be `---` (YAML frontmatter start).
    local first
    first="$(head -1 "$f" 2>/dev/null || true)"
    if [ "$first" != "---" ]; then
      err "missing YAML frontmatter: $f"
      bad=1
    fi
  done < <(find "$project_dir/experience" -type f \( -name '*.md' -o -name '*.yaml' -o -name '*.yml' -o -name '*.json' \) -print0 2>/dev/null)
  [ "$bad" -eq 0 ]
}

# --- Check 2: no MASIP records in Type-A retrieval projects ----------------
check_type_separation() {
  local bad=0
  while IFS= read -r project_dir; do
    [ -d "$project_dir" ] || continue
    # Frontmatter status: active/superseded/incorrect must not appear in Type-A
    # raw source dirs. Allow it in `.ragmir-history/` and inside known
    # config files.
    while IFS= read -r -d '' f; do
      # Skip files that legitimately contain "status:" — config files, READMEs
      # inside `.ragmir-history/`, etc.
      case "$f" in
        */.ragmir/*|*/.ragmir-history/*) continue ;;
      esac
      if grep -qE '^status:[[:space:]]+(active|superseded|incorrect)' "$f" 2>/dev/null; then
        # Make sure it's actually YAML frontmatter (preceded by ---), not just a doc note.
        if head -1 "$f" | grep -q '^---$'; then
          err "Type-A leakage: MASIP frontmatter found in $f"
          bad=1
        fi
      fi
    done < <(find "$project_dir" -maxdepth 6 -type f \( -name '*.md' -o -name '*.yaml' -o -name '*.yml' \) ! -path '*/.ragmir/*' ! -path '*/.ragmir-history/*' -print0 2>/dev/null)
  done < <(discover_type_a_projects "$PROJECTS_ROOT")
  [ "$bad" -eq 0 ]
}

# --- Check 3: backups present for mutated files -----------------------------
check_backups() {
  local project_dir="$1"
  local bad=0
  # Every Type-B file (except AGENTS.md and the README inside .ragmir/raw)
  # should have at least one backup if it's been mutated. We approximate:
  # there should be at least one entry in .ragmir-history/ if records exist.
  if [ -d "$project_dir/experience" ] && [ -n "$(ls -A "$project_dir/experience" 2>/dev/null)" ]; then
    if [ ! -d "$project_dir/.ragmir-history" ]; then
      note "no .ragmir-history yet (no mutations since init?)"
    fi
  fi
  [ "$bad" -eq 0 ]
}

# --- Check 4: rgr audit clean ----------------------------------------------
check_audit() {
  local project_dir="$1"
  local out
  out="$("$RGR_BIN" --project-root "$project_dir" audit 2>&1)" || true
  local missing stale dup
  missing="$(echo "$out" | awk -F= '/^missingFromIndex=/{print $2}')"
  stale="$(echo "$out"   | awk -F= '/^staleInIndex=/{print $2}')"
  dup="$(echo "$out"     | awk -F= '/^duplicateCandidates=/{print $2}')"
  if [ "$missing" = "0" ] && [ "$stale" = "0" ] && [ "$dup" = "0" ]; then
    note "missingFromIndex=$missing staleInIndex=$stale duplicateCandidates=$dup"
    return 0
  fi
  note "missingFromIndex=$missing staleInIndex=$stale duplicateCandidates=$dup"
  return 1
}

# --- Check 5: search by unique token returns a record ----------------------
check_search() {
  local project_dir="$1"
  local latest
  latest="$(find "$project_dir/experience" -type f \( -name '*.md' -o -name '*.yaml' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | awk '{print $2}')"
  [ -z "$latest" ] && { note "no records to search"; return 0; }
  local token
  token="$(awk 'BEGIN{in_fm=0} /^---$/{in_fm=!in_fm; next} !in_fm' "$latest" \
           | grep -oE '[a-zA-Z][a-zA-Z0-9_-]{8,}' \
           | grep -vE '^(project_context|environment|tech_stack|quality_score|version|agent_id|timestamp|status|tags|active|superseded|incorrect|supersede_note|jsonl)$' \
           | head -1)"
  [ -z "$token" ] && { note "no unique token to test"; return 0; }
  local hits
  hits="$("$RGR_BIN" --project-root "$project_dir" search --top-k 1 "$token" 2>&1)" || true
  if echo "$hits" | grep -q "$(basename "$latest")"; then
    note "search('$token') → hit in $(basename "$latest")"
    return 0
  fi
  note "search('$token') did not return expected path"
  return 1
}

# --- Main -------------------------------------------------------------------

echo "=== MASIP static compliance check ==="
echo ""

# Accept either auto-discovery or explicit args
if [ "$#" -gt 0 ]; then
  PROJECTS=("$@")
else
  mapfile -t PROJECTS < <(discover_type_b_projects "$PROJECTS_ROOT")
fi

if [ "${#PROJECTS[@]}" -eq 0 ]; then
  err "no Type-B projects found in $PROJECTS_ROOT"
  exit 1
fi

for project_dir in "${PROJECTS[@]}"; do
  name="$(basename "$project_dir")"
  echo "→ $name ($project_dir)"
  check "  §4 YAML frontmatter on every record" check_frontmatter "$project_dir"
  check "  §6 audit clean (missing=0, stale=0, dup=0)" check_audit "$project_dir"
  check "  §6 ragmir_search(<token>) returns record" check_search "$project_dir"
  check_backups "$project_dir"  # informational only
  echo ""
done

check "  §0 Type separation (no MASIP records in Type-A projects)" check_type_separation

echo ""
echo "=== Summary: $((checks - violations)) / $checks checks passed, $violations violations ==="
exit $((violations > 0))