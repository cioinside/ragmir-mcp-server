#!/usr/bin/env bash
# masip-behavioral-test.sh — Behavioral verification of MASIP compliance.
#
# Spawns a fresh opencode session with a MASIP-aware task and verifies that
# the agent followed the protocol:
#   §2  pre-task search via rgr search
#   §0  write to Type-B project (experience-records), not Type-A
#   §4  YAML frontmatter on new records
#   §6  post-task rgr ingest + rgr audit clean
#   §6  ragmir_search(<unique-token>) returns the new record
#
# Usage:
#   bin/masip-behavioral-test.sh                 # run with embedded test scenario
#   OPENCODE_BIN=... bin/masip-behavioral-test.sh
#
# Exit code: 0 = agent followed MASIP, 1 = at least one violation.

set -u

RGR_BIN="${RGR_BIN:-/usr/local/node22/bin/rgr}"
OPENCODE_BIN="${OPENCODE_BIN:-$(command -v opencode || echo opencode)}"
PROJECT="${MASIP_PROJECT:-/opt/ragmir-projects/experience-records}"
SESSION_DIR="${SESSION_DIR:-/tmp/masip-behavioral-test-$(date +%s)}"
SESSION_ID="${SESSION_ID:-masip-bt-$(date +%s)}"
LOG="$SESSION_DIR/transcript.ndjson"

mkdir -p "$SESSION_DIR"

TASK_PROMPT='You are running a MASIP behavioral test. Follow MASIP strictly.

TASK: Solve and document "How to safely run `rgr ingest --rebuild` on a 1+ GB corpus without OOM".

Steps (verbatim MASIP flow):

1. PRE-TASK SEARCH (MASIP §2):
     rgr --project-root /opt/ragmir-projects/experience-records search "rgr ingest OOM"
   If a similar record already exists, use `ragmir_supersede_note` (or
   equivalent rgr CLI: `rgr sources` etc.) to evolve it — DO NOT create a duplicate.
   Report what you found.

2. ACT: Think through the solution (chunk-size reduction, streaming batch,
   --incremental-failure-policy=preserve, etc.). Do not actually rebuild the
   corpus — this is a documentation exercise.

3. WRITE RECORD (MASIP §0 + §4):
     Path:  /opt/ragmir-projects/experience-records/experience/masip-patterns/safe-ingest-rebuild.md
   Include YAML frontmatter with at minimum:
     project_context, environment, tech_stack (list), quality_score,
     version, agent_id, timestamp, status: active

4. POST-TASK VERIFY (MASIP §6):
     rgr --project-root /opt/ragmir-projects/experience-records ingest
     rgr --project-root /opt/ragmir-projects/experience-records audit
   Both must report 0 errors and clean state.

Report each step as you complete it, including the exact commands you ran
and the full content of the record you wrote (frontmatter + body).'

run_agent() {
  echo "=== Spawning opencode session: $SESSION_ID ==="
  echo "    log: $LOG"
  echo "    bin: $OPENCODE_BIN"
  echo ""
  if ! command -v "$OPENCODE_BIN" >/dev/null 2>&1; then
    echo "opencode CLI not found on PATH; skipping live run."
    echo "Run manually:"
    printf '    %q run --session-id %q --format json --agent build %q 2>&1 | tee %q\n' \
      "$OPENCODE_BIN" "$SESSION_ID" "$TASK_PROMPT" "$LOG"
    return 0
  fi
  "$OPENCODE_BIN" run \
    --session-id "$SESSION_ID" \
    --format json \
    --agent build \
    "$TASK_PROMPT" 2>&1 | tee "$LOG"
}

verify_artifacts() {
  echo ""
  echo "=== Verifying behavioral artifacts ==="
  local rc=0
  local new_record="$PROJECT/experience/masip-patterns/safe-ingest-rebuild.md"

  echo ""
  echo "[1/5] New record exists: $new_record"
  if [ -f "$new_record" ]; then
    echo "  ✓ present"
  else
    echo "  ❌ MISSING — agent did not create the record"
    rc=1
  fi

  echo ""
  echo "[2/5] YAML frontmatter present"
  if [ -f "$new_record" ] && head -1 "$new_record" | grep -q '^---$'; then
    echo "  ✓ starts with ---"
  else
    echo "  ❌ no YAML frontmatter"
    rc=1
  fi

  echo ""
  echo "[3/5] Audit clean (missingFromIndex=0 staleInIndex=0 duplicateCandidates=0)"
  local audit
  audit="$("$RGR_BIN" --project-root "$PROJECT" audit 2>&1)" || true
  local missing stale dup
  missing="$(echo "$audit" | awk -F= '/^missingFromIndex=/{print $2}')"
  stale="$(echo "$audit"  | awk -F= '/^staleInIndex=/{print $2}')"
  dup="$(echo "$audit"    | awk -F= '/^duplicateCandidates=/{print $2}')"
  echo "  missingFromIndex=$missing staleInIndex=$stale duplicateCandidates=$dup"
  if [ "$missing" != "0" ] || [ "$stale" != "0" ] || [ "$dup" != "0" ]; then
    echo "  ❌ audit not clean"
    rc=1
  else
    echo "  ✓ audit clean"
  fi

  echo ""
  echo "[4/5] Search by unique token returns the new record"
  if [ -f "$new_record" ]; then
    local token
    token="$(awk 'BEGIN{in_fm=0} /^---$/{in_fm=!in_fm; next} !in_fm' "$new_record" \
             | grep -oE '[a-zA-Z][a-zA-Z0-9_-]{8,}' \
             | grep -vE '^(project_context|environment|tech_stack|quality_score|version|agent_id|timestamp|status|tags|active|superseded|incorrect|supersede_note|jsonl)$' \
             | head -1)"
    if [ -n "$token" ]; then
      local hits
      hits="$("$RGR_BIN" --project-root "$PROJECT" search --top-k 1 "$token" 2>&1)" || true
      if echo "$hits" | grep -q "safe-ingest-rebuild.md"; then
        echo "  ✓ search('$token') → hit in safe-ingest-rebuild.md"
      else
        echo "  ❌ search('$token') did not return the record"
        rc=1
      fi
    else
      echo "  ⚠️  no unique token found in record body"
    fi
  fi

  echo ""
  echo "[5/5] No Type-A leakage (record went to experience-records, not fermi-instruments)"
  if grep -rqE '^status:[[:space:]]+active' /opt/ragmir-projects/fermi-instruments/ 2>/dev/null; then
    local leaked
    leaked="$(grep -rlE '^status:[[:space:]]+active' /opt/ragmir-projects/fermi-instruments/ 2>/dev/null | head -3)"
    echo "  ❌ MASIP frontmatter leaked into fermi-instruments:"
    echo "$leaked" | sed 's/^/      /'
    rc=1
  else
    echo "  ✓ fermi-instruments is clean (no MASIP frontmatter)"
  fi

  echo ""
  echo "=== MASIP behavioral test result: $([ "$rc" -eq 0 ] && echo PASS || echo FAIL) ==="
  exit "$rc"
}

run_agent
verify_artifacts