#!/bin/bash
#
# The daily run. Mirror what publishers served today, look for closed periods
# that moved, and seal the result.
#
# A mirror that is not re-read proves nothing: the method is comparison over
# time, so a copy taken once is a snapshot, not evidence. On 2026-09-02 the
# previous copy of Costa Rica was six days old and the gap alone was enough to
# make a routine month-end refresh look like a rewrite.
#
# Costa Rica is the only source with an evidence chain. The canonicaliser reads
# SICOP's CSV schema, so watch, snapshot and anchor are CR-only by construction.
# Panama is mirrored — preserved, hashed, never overwritten — and nothing more.
# Honduras is left out on purpose: its certificate expired on 2026-07-05, and a
# job running unattended should not be the thing that decides to accept an
# unauthenticated publisher. Add --source hn by hand when you mean it.
#
# Exit codes: 0 quiet, 2 a closed period was rewritten with real changes,
# 1 something failed. 2 is passed through from watch so a wrapper can page
# someone without parsing prose.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ANCLA_LOG_DIR:-$HOME/ancla-data/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/daily-$(date -u +%Y-%m-%d).log"

# PATH is minimal under launchd; node is wherever the user's install put it.
NODE="${ANCLA_NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"

say() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*" >>"$LOG"; }

say "=== ancla daily start ==="
status=0

say "--- mirror Panama"
"$NODE" "$REPO/packages/ingest/src/cli.ts" mirror --source pa -c 4 >>"$LOG" 2>&1 \
  || { say "panama mirror FAILED"; status=1; }

# watch mirrors Costa Rica itself, then snapshots and diffs whatever moved.
say "--- watch Costa Rica"
"$NODE" "$REPO/packages/cli/src/main.ts" watch >>"$LOG" 2>&1
watch_rc=$?
if [ "$watch_rc" -eq 2 ]; then
  say "FINDING: a closed month was rewritten with real changes"
  status=2
elif [ "$watch_rc" -ne 0 ]; then
  say "watch FAILED rc=$watch_rc"
  status=1
fi

# Broadcasting spends DCC and writes to a public chain, so it is opt-in through
# the environment rather than on by default. Without it this still prints the
# plan, which is what makes the dry run worth reading.
say "--- anchor"
if [ "${ANCLA_BROADCAST:-0}" = "1" ]; then
  "$NODE" "$REPO/packages/cli/src/main.ts" anchor --broadcast >>"$LOG" 2>&1 \
    || { say "anchor FAILED"; status=1; }
else
  "$NODE" "$REPO/packages/cli/src/main.ts" anchor >>"$LOG" 2>&1 \
    || { say "anchor plan FAILED"; status=1; }
  say "anchor was a dry run. set ANCLA_BROADCAST=1 to seal."
fi

say "=== ancla daily end status=$status ==="
exit "$status"
