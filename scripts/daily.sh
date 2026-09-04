#!/bin/bash
#
# The daily run. Mirror what publishers served today, look for closed periods
# that moved, write a row-level bundle for any that did, and seal the result.
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

# Canonicalise anything that is on disk without a snapshot.
#
# watch only snapshots the copy it downloaded on this run, so an archive that
# arrived any other way — the original bulk mirror, a manual `mirror`, a watch
# from before capture anchoring existed — has no root, and a capture with no root
# is silently skipped by the anchor step below. We hold the bytes and cannot prove
# we held them, which is the failure this whole layer exists to prevent. snapshot
# is idempotent and skips what already exists, so this costs seconds on a quiet
# day and closes the hole on a bad one.
for src in cr pa; do
  say "--- snapshot $src"
  "$NODE" "$REPO/packages/cli/src/main.ts" snapshot --source "$src" >>"$LOG" 2>&1 \
    || { say "snapshot $src FAILED"; status=1; }
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
# The daily root above is addressed by the day this job ran. That is enough to
# prove the record changed and it has one hole: a copy that arrives and is
# replaced between two runs, or a day this job does not run, takes that copy's
# root with it. So every capture and every published bundle also gets a key
# derived from its own bytes, which is idempotent — the contract refuses to
# overwrite, and already-committed keys are dropped from the plan before it is
# signed, so this costs nothing on a quiet day.
for src in cr pa; do
  say "--- anchor captures $src"
  if [ "${ANCLA_BROADCAST:-0}" = "1" ]; then
    "$NODE" "$REPO/packages/cli/src/main.ts" anchor --versions --source "$src" --broadcast >>"$LOG" 2>&1 \
      || { say "capture anchor $src FAILED"; status=1; }
  else
    "$NODE" "$REPO/packages/cli/src/main.ts" anchor --versions --source "$src" >>"$LOG" 2>&1 \
      || { say "capture anchor $src plan FAILED"; status=1; }
  fi
done

[ "${ANCLA_BROADCAST:-0}" = "1" ] || say "anchors were dry runs. set ANCLA_BROADCAST=1 to seal."

# Republish the site.
#
# The evidence site is a static export of what this job just produced, and the
# export can only run where the mirror is — which is here, not on a build server.
# Without this step the published site is a photograph of whichever day someone
# last ran it by hand, which is a strange thing for a project whose entire claim
# is a daily record.
#
# Opt-in through the environment, like ANCLA_BROADCAST, because it writes to a
# public host. `railway up` needs the directory linked once:
#   cd "$HOME/ancla-data/site" && railway link --project ancla
RAILWAY="${ANCLA_RAILWAY:-$(command -v railway || echo /opt/homebrew/bin/railway)}"
SITE_DIR="${ANCLA_SITE_DIR:-$HOME/ancla-data/site}"

if [ "${ANCLA_PUBLISH:-0}" = "1" ]; then
  say "--- export site"
  if "$NODE" --max-old-space-size=4096 "$REPO/packages/delivery/src/export.ts" "$SITE_DIR" >>"$LOG" 2>&1; then
    say "--- publish site"
    if [ -x "$RAILWAY" ]; then
      ( cd "$SITE_DIR" && "$RAILWAY" up --detach --service ancla ) >>"$LOG" 2>&1 \
        || { say "publish FAILED"; status=1; }
    else
      say "publish skipped: no railway CLI at $RAILWAY"
    fi
  else
    say "export FAILED"
    status=1
  fi
else
  say "site not republished. set ANCLA_PUBLISH=1 to publish after each run."
fi

say "=== ancla daily end status=$status ==="
exit "$status"
