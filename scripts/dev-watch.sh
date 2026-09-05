#!/usr/bin/env bash
# Keep the installed app on main (DECISIONS D-050): fetch origin, and
# whenever main has moved since the last dev build, build and install it
# from a dedicated worktree (../pfi-dev-build) so the working tree -- and
# whatever branch is checked out there -- is never touched. One pass per
# call; the launch agent below calls it every two minutes.
#
#   scripts/dev-watch.sh              one pass
#   scripts/dev-watch.sh --install    write + load the launch agent (this user)
#   scripts/dev-watch.sh --uninstall  unload + remove it
#   scripts/dev-watch.sh --status     what is installed vs. main
#
# Log: ~/Library/Logs/corbits-dev-build.log. A failed build is not
# retried until main moves again (or you run dev-install.sh yourself).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(dirname "$REPO")"
WT="$PARENT/pfi-dev-build"
STAMP="$PARENT/.pfi-dev-built"
LABEL="com.corbits.pfi.dev-build"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/corbits-dev-build.log"
LOCK="${TMPDIR:-/tmp}/pfi-dev-build.lock"

case "${1:-}" in
  --install)
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/scripts/dev-watch.sh</string></array>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "dev-watch: launch agent $LABEL loaded (every 2 minutes; log: $LOG)"
    exit 0 ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "dev-watch: launch agent removed"
    exit 0 ;;
  --status)
    git -C "$REPO" fetch -q origin main
    echo "main:      $(git -C "$REPO" rev-parse --short origin/main) $(git -C "$REPO" log -1 --format=%s origin/main)"
    echo "installed: $(cut -c1-7 "$STAMP" 2>/dev/null || echo '(no dev build yet)')"
    [ -f "$STAMP.failed" ] && echo "failed:    $(cut -c1-7 "$STAMP.failed") (see $LOG)"
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "agent:     loaded" || echo "agent:     not loaded (scripts/dev-watch.sh --install)"
    exit 0 ;;
  "") ;;
  *) echo "usage: scripts/dev-watch.sh [--install|--uninstall|--status]" >&2; exit 2 ;;
esac

# One pass. macOS has no flock(1); an atomic mkdir is the lock.
if ! mkdir "$LOCK" 2>/dev/null; then exit 0; fi
trap 'rmdir "$LOCK"' EXIT

cd "$REPO"
git fetch -q origin main
HEAD_MAIN="$(git rev-parse origin/main)"
if [ "$HEAD_MAIN" = "$(cat "$STAMP" 2>/dev/null || true)" ]; then exit 0; fi
if [ "$HEAD_MAIN" = "$(cat "$STAMP.failed" 2>/dev/null || true)" ]; then exit 0; fi

echo "== $(date -u +%FT%TZ) dev-watch: main moved to $(git rev-parse --short "$HEAD_MAIN"); building"
if [ ! -d "$WT" ]; then
  git worktree add --detach "$WT" "$HEAD_MAIN"
else
  git -C "$WT" checkout -q --detach "$HEAD_MAIN"
fi
if (cd "$WT" && bun install --frozen-lockfile >/dev/null && scripts/dev-install.sh); then
  echo "$HEAD_MAIN" > "$STAMP"
  rm -f "$STAMP.failed"
  echo "== $(date -u +%FT%TZ) dev-watch: installed $(git rev-parse --short "$HEAD_MAIN")"
else
  echo "$HEAD_MAIN" > "$STAMP.failed"
  echo "== $(date -u +%FT%TZ) dev-watch: BUILD FAILED for $(git rev-parse --short "$HEAD_MAIN"); not retried until main moves"
  exit 1
fi
