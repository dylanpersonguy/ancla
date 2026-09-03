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

# The seed is read from the login keychain when it is there, so the signing key
# does not have to sit in a readable file. loadSeed prefers ANCLA_SEED over
# ~/ancla-data/anchor.key, so this is the whole integration.
#
# It is exported only for the anchor step, never logged, and a miss is silent:
# the file remains the fallback, and anchor fails loudly on its own if neither
# exists. Under launchd this works because the login keychain is unlocked for a
# logged-in session, and a run deferred to wake happens after unlock.
if SEED="$(security find-generic-password -a ancla -s ancla-anchor-seed -w 2>/dev/null)" \
   && [ -n "$SEED" ]; then
  export ANCLA_SEED="$SEED"
  SEED_SOURCE="keychain"
else
  SEED_SOURCE="file"
fi
unset SEED

say "=== ancla daily start ==="
say "seed source: $SEED_SOURCE"
status=0

# Costa Rica and Panama both have a schema, so both run the whole chain: watch
# mirrors the source, snapshots whatever moved, and diffs it against the copy
# held before. Honduras is left out on purpose — its certificate expired on
# 2026-07-05 and an unattended job is the wrong place to decide to accept an
# unauthenticated publisher. Add --source hn by hand when you mean it.
for src in cr pa; do
  say "--- watch $src"
  "$NODE" "$REPO/packages/cli/src/main.ts" watch --source "$src" >>"$LOG" 2>&1
  rc=$?
  if [ "$rc" -eq 2 ]; then
    say "FINDING ($src): a closed period was rewritten with real changes"
    status=2
  elif [ "$rc" -ne 0 ]; then
    say "watch $src FAILED rc=$rc"
    status=1
  fi
done

# Broadcasting spends DCC and writes to a public chain, so it is opt-in through
# the environment rather than on by default. Without it this still prints the
# plan, which is what makes the dry run worth reading.
for src in cr pa; do
  say "--- anchor $src"
  if [ "${ANCLA_BROADCAST:-0}" = "1" ]; then
    "$NODE" "$REPO/packages/cli/src/main.ts" anchor --source "$src" --broadcast >>"$LOG" 2>&1 \
      || { say "anchor $src FAILED"; status=1; }
  else
    "$NODE" "$REPO/packages/cli/src/main.ts" anchor --source "$src" >>"$LOG" 2>&1 \
      || { say "anchor $src plan FAILED"; status=1; }
  fi
done
[ "${ANCLA_BROADCAST:-0}" = "1" ] || say "anchors were dry runs. set ANCLA_BROADCAST=1 to seal."

say "=== ancla daily end status=$status ==="
exit "$status"
