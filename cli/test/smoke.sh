#!/usr/bin/env bash
# Shim-based smoke test: exercises the real planner/engine end to end with a fake
# `ddev` on PATH, so it needs no Docker. Run via `npm run test:smoke`.
#
#   test/smoke.sh            build if needed, run, clean up
#   KEEP=1 test/smoke.sh     keep the scratch repo and print its path
set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$CLI_DIR/dist/cli.js" ] || (cd "$CLI_DIR" && npm run --silent build)

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wt-smoke.XXXXXX")"
SHIM="$WORK/shim"
REPO="$WORK/repo/myshop"
export WT_SHIM_LOG="$WORK/ddev-calls.log"

cleanup() {
  local rc=$?
  if [ -n "${KEEP:-}" ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
  [ $rc -eq 0 ] && echo "smoke: PASS" || echo "smoke: FAIL (exit $rc)" >&2
  exit $rc
}
trap cleanup EXIT

fail() { echo "  ✗ $*" >&2; exit 1; }
ok()   { echo "  ✓ $*"; }
step() { echo "→ $*"; }

# assert_contains <haystack> <needle> <label>
assert_contains() { case "$1" in *"$2"*) ok "$3" ;; *) fail "$3: expected '$2' in: $1" ;; esac; }
assert_missing()  { case "$1" in *"$2"*) fail "$3: did not expect '$2' in: $1" ;; *) ok "$3" ;; esac; }

# jget <json> <dotted.path> — read one field out of a --json response (no jq dependency)
jget() { node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String(process.argv[2].split(".").reduce((a,k)=>a?.[k],o)))' "$1" "$2"; }

# ---------------------------------------------------------------- fake ddev --
mkdir -p "$SHIM"
cat > "$SHIM/ddev" <<'EOF'
#!/bin/sh
# Fake ddev. Logs every call, fabricates just enough output for wt to proceed.
[ -n "$WT_SHIM_LOG" ] && echo "$*" >> "$WT_SHIM_LOG"
case "$1" in
  version) echo "DDEV version v1.24.0" ;;
  list)    echo '{"raw":[{"name":"myshop","status":"running","approot":"'"$WT_MAIN_APPROOT"'"}]}' ;;
  snapshot)
    if [ "$2" = "--name" ]; then
      mkdir -p .ddev/db_snapshots && echo x > ".ddev/db_snapshots/$3-mariadb_10.11.gz"
    fi
    echo "[ddev] $*" ;;
  export-db)
    # ddev export-db --file <path> ...
    shift; while [ "$1" != "--file" ] && [ $# -gt 0 ]; do shift; done
    [ $# -gt 1 ] && { mkdir -p "$(dirname "$2")"; echo "-- fake dump" > "$2"; }
    echo "[ddev] export-db" ;;
  exec)  shift; echo "[ddev exec] $*" ;;
  *)     echo "[ddev] $*" ;;
esac
EOF
chmod +x "$SHIM/ddev"
export PATH="$SHIM:$PATH"
WT="node $CLI_DIR/dist/cli.js"

# ------------------------------------------------------------ fake WP repo --
step "scaffold a WordPress repo at $REPO"
mkdir -p "$REPO/wp-content/uploads" "$REPO/.ddev"
cd "$REPO"
export WT_MAIN_APPROOT="$PWD"
git init -q -b main && git config user.email smoke@example.com && git config user.name smoke
echo "<?php" > wp-config.php
echo "type: wordpress" > .ddev/config.yaml
printf 'main: myshop\ndb:\n  track_tables: [wp_options, wp_posts]\n' > .wt.yml
printf '.wt/\nwp-config-wt.php\n' > .gitignore
git add -A && git commit -qm init
ok "repo scaffolded"

step "wt doctor"
$WT doctor >/dev/null || fail "doctor exited non-zero"
ok "doctor ran"

# -------------------------------------------------------------------- new --
step "wt new feat/x --task 'checkout page'"
OUT="$($WT --json new feat/x --task "checkout page")"
assert_contains "$OUT" '"ok":true'                "new succeeded"
assert_contains "$OUT" 'https://feat-x.ddev.site' "worktree URL is the slugified branch"
[ -d ".wt/worktrees/feat-x" ] || fail "worktree directory missing"
ok "worktree directory created"
grep -q '"feat-x"' .wt/manifest.json || fail "feat-x not recorded in manifest"
ok "manifest records feat-x"
[ -f ".wt/worktrees/feat-x/wp-config-wt.php" ] || fail "wp-config-wt.php not generated"
assert_contains "$(cat .wt/worktrees/feat-x/wp-config-wt.php)" "feat-x.ddev.site" "generated wp-config points at the worktree URL"
[ -f ".wt/worktrees/feat-x/.ddev/config.wt.local.yaml" ] || fail ".ddev/config.wt.local.yaml not generated"
ok "ddev override written"
git -C . worktree list | grep -q "feat-x" || fail "git does not know about the worktree"
ok "git worktree registered"

step "media is symlinked and the URL fixup is wired as a post-start hook"
[ -L ".wt/worktrees/feat-x/wp-content/uploads" ] || fail "uploads is not a symlink"
ok "uploads symlinked to main"
HOOKS="$(cat .wt/worktrees/feat-x/.ddev/config.wt.local.yaml)"
assert_contains "$HOOKS" "post-start"                          "post-start hooks present"
assert_contains "$HOOKS" "search-replace 'https://myshop.ddev.site' 'https://feat-x.ddev.site'" \
                                                               "search-replace rewrites main URL to worktree URL"
# The hooks only take effect on the start that follows the DB restore. Guard that
# ordering: a `start` must appear after `snapshot restore` in the ddev call log.
grep -n . "$WT_SHIM_LOG" | awk -F: '/snapshot restore/{r=$1} /^[0-9]+:start -y/{if(r&&$1>r){found=1}} END{exit !found}' \
  || fail "no ddev start after snapshot restore — URL fixup hooks would never run"
ok "ddev start runs after snapshot restore (hooks fire on restored DB)"

# ---------------------------------------------------------------- ls / url --
step "wt ls / wt url"
assert_contains "$($WT --json ls)"        '"feat-x"'                 "ls lists feat-x"
assert_contains "$($WT --json url feat-x)" 'https://feat-x.ddev.site' "url returns the worktree URL"

step "wt context"
assert_contains "$($WT --json context)" 'feat-x' "context sees the worktree"

# ------------------------------------------------------------------- pool --
step "wt pool fill 1 → wt new --pool must claim it"
$WT --json pool fill 1 >/dev/null || fail "pool fill failed"
POOL="$($WT --json pool ls)"
assert_contains "$POOL" "pool-" "pool has an entry"
OUT="$($WT --json new feat/pooled --task "pooled task" --pool)"
assert_contains "$OUT" 'https://feat-pooled.ddev.site' "claimed worktree serves the new hostname"
# The pool name may legitimately appear in level_reasons / plan (it explains the
# provenance); what must never carry it is the worktree record itself.
REC="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).worktree))' "$OUT")"
assert_missing "$REC" 'pool-' "no pool- name leaks into the claimed worktree record"
[ "$(jget "$OUT" worktree.name)" = "feat-pooled" ] || fail "claimed worktree kept the pool name"
ok "worktree renamed to feat-pooled"
assert_contains "$OUT" 'URL fixup from https://pool-' "start rewrites the pool URL to the new hostname"
assert_contains "$($WT --json pool ls)" '"pool":[]'    "pool entry consumed"
$WT --json destroy feat-pooled >/dev/null || fail "destroy feat-pooled failed"
ok "claimed worktree destroyed"

# ---------------------------------------------------------------- destroy --
step "wt destroy feat-x"
assert_contains "$($WT --json destroy feat-x)" '"destroyed":"feat-x"' "destroy reported success"
if [ -d ".wt/worktrees/feat-x" ]; then fail "worktree directory survived destroy"; fi
ok "worktree directory removed"
if grep -q '"feat-x"' .wt/manifest.json; then fail "feat-x still in manifest"; fi
ok "manifest cleaned"
if git -C . worktree list | grep -q "feat-x"; then fail "git worktree not pruned"; fi
ok "git worktree pruned"
assert_contains "$(cat "$WT_SHIM_LOG")" "delete -Oy feat-x" "ddev project deleted"
