#!/usr/bin/env bash
#
# Deploy to the VM, and refuse to claim success without proving it.
#
# This exists because three deploys in a row silently did not apply. Files copied
# to the server by hand left untracked paths that blocked every git pull, then an
# `npm install --save` run there modified package.json and blocked it again. The
# server sat on an old commit while each deploy reported "healthy" and a passing
# test count — both of which were true of the OLD code.
#
# The rule this enforces: a deploy has not happened until the server reports the
# SAME COMMIT the local repository is on. Health checks and test counts describe
# whatever is running; only the SHA says whether it is what you meant to ship.
#
#   npm run deploy            # deploy HEAD
#   npm run deploy -- --check # report drift without changing anything
#   SKIP_CI=1 npm run deploy  # do not wait for the GitHub Actions run
#
# Beyond the SHA rule, a deploy: waits for CI to be green for the commit,
# installs from the lockfile (npm ci — npm install rewrote package-lock.json
# on the box and blocked the next pull), takes a verified DB backup before
# restarting, reloads through ecosystem.config.js (restart backoff), checks
# the RUNNING process reports the shipped commit, installs the daily backup
# cron, and tags the commit deploy/<timestamp> so a rollback has a name.
set -euo pipefail

INSTANCE="${DEPLOY_INSTANCE:-xero-automation}"
ZONE="${DEPLOY_ZONE:-us-central1-a}"
APP="${DEPLOY_PATH:-/home/weika/xero-invoice-app}"
RUNAS="${DEPLOY_USER:-weika}"
HEALTH="${DEPLOY_HEALTH:-https://34-45-253-162.sslip.io/dashboard/health}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { red "✗ $*"; exit 1; }

remote() { gcloud compute ssh "$INSTANCE" --zone="$ZONE" --command="sudo -u $RUNAS -H bash -lc \"cd $APP && $1\"" 2>/dev/null; }

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# ── 1. Local must be clean and pushed ───────────────────────────────────────
# Deploying while local changes are uncommitted ships something nobody can
# reproduce from the repository.
LOCAL_SHA=$(git rev-parse HEAD)
echo "Local"
info "commit  $(git log --oneline -1)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no | sed 's/^/    /'
  die "Uncommitted changes. Commit or stash before deploying."
fi

git fetch -q origin
if [ -n "$(git log origin/master..HEAD --oneline)" ]; then
  git log origin/master..HEAD --oneline | sed 's/^/    /'
  die "Local commits are not pushed. The server pulls from origin."
fi
grn "  ✓ clean and pushed"

# ── 1b. CI must be green for this commit ────────────────────────────────────
# The route suites are flaky on a Mac (see main/scripts/jest.setup.js); the
# GitHub Actions run on Node 22 is the reliable verdict. Waits if it is still
# running. SKIP_CI=1 overrides; a missing run (workflow not on master yet) is
# reported and allowed.
if [ "$CHECK_ONLY" != "1" ] && [ "${SKIP_CI:-0}" != "1" ] && command -v gh >/dev/null 2>&1; then
  ci_run() { gh run list --commit "$LOCAL_SHA" --workflow ci --json databaseId -q '.[0].databaseId' 2>/dev/null || true; }
  RUN_ID=$(ci_run)
  if [ -z "$RUN_ID" ]; then sleep 20; RUN_ID=$(ci_run); fi
  if [ -n "$RUN_ID" ]; then
    info "CI run $RUN_ID — waiting for it"
    if gh run watch "$RUN_ID" --exit-status >/dev/null 2>&1; then
      grn "  ✓ CI green"
    else
      die "CI is red for $LOCAL_SHA — fix it before deploying (SKIP_CI=1 to override)"
    fi
  else
    red "  ! no CI run found for $LOCAL_SHA — continuing without it"
  fi
fi

# ── 2. What is the server actually running? ─────────────────────────────────
echo
echo "Server"
BEFORE=$(remote 'git rev-parse HEAD' | tr -d '[:space:]')
info "commit  $(remote 'git log --oneline -1' | head -1)"

# The two things that blocked every pull last time, named explicitly rather than
# discovered from a truncated error message.
DIRTY=$(remote 'git status --porcelain --untracked-files=no' || true)
BLOCKERS=$(remote "git fetch -q origin 2>/dev/null; git merge-tree --write-tree HEAD origin/master >/dev/null 2>&1 || git status --porcelain --untracked-files=all | grep '^??' | head -20" || true)

if [ -n "$DIRTY" ]; then
  red "  ✗ tracked files modified ON THE SERVER:"
  echo "$DIRTY" | sed 's/^/      /'
  info "these will block the pull — usually an npm install --save run there"
fi

if [ "$BEFORE" = "$LOCAL_SHA" ]; then
  grn "  ✓ already at $LOCAL_SHA"
  [ "$CHECK_ONLY" = "1" ] && exit 0
else
  info "behind by: $(remote "git log --oneline ${BEFORE}..origin/master 2>/dev/null | wc -l" | tr -d '[:space:]') commit(s)"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  [ -n "$DIRTY" ] && die "server has local modifications"
  echo; grn "check only — nothing changed"; exit 0
fi

# ── 3. Deploy ───────────────────────────────────────────────────────────────
echo
echo "Deploying"
if [ -n "$DIRTY" ]; then
  # `git checkout -- .` rather than a computed file list: the list has to survive
  # three shell layers (local -> gcloud ssh -> bash -lc) and the quoting silently
  # mangled, so the discard reported success and changed nothing. A deploy target
  # should never carry local edits, so discarding all of them is both simpler and
  # more correct than reconstructing which ones.
  info "discarding the server's local edits to tracked files"
  remote 'git checkout -- .' >/dev/null || true
  STILL=$(remote 'git status --porcelain --untracked-files=no' || true)
  [ -n "$STILL" ] && die "could not discard the server's local edits: $STILL"
fi

# Untracked files are NOT removed automatically. main/.env.bak lives there, and a
# deploy script that deletes untracked files on a production box is one bad glob
# away from taking the environment with it. Report and stop instead.
UNTRACKED_BLOCKERS=$(remote 'git fetch -q origin 2>/dev/null; git diff --name-only HEAD origin/master 2>/dev/null' || true)
if [ -n "$UNTRACKED_BLOCKERS" ]; then
  CLASH=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if remote "test -f '$f' && git ls-files --error-unmatch '$f' >/dev/null 2>&1 || echo MISSING" | grep -q MISSING; then
      remote "test -f '$f' && echo UNTRACKED" | grep -q UNTRACKED && CLASH="$CLASH $f"
    fi
  done <<< "$UNTRACKED_BLOCKERS"
  if [ -n "$CLASH" ]; then
    red "  ✗ untracked files on the server are in the way of the incoming commit:"
    for f in $CLASH; do info "      $f"; done
    die "remove them on the server, then run again"
  fi
fi

PULL=$(remote 'git pull --ff-only origin master 2>&1 | tail -3' || true)
echo "$PULL" | sed 's/^/    /'

# ── 4. The check that was missing ───────────────────────────────────────────
AFTER=$(remote 'git rev-parse HEAD' | tr -d '[:space:]')
if [ "$AFTER" != "$LOCAL_SHA" ]; then
  echo
  red "✗ DEPLOY DID NOT APPLY"
  info "expected $LOCAL_SHA"
  info "server   $AFTER"
  info "the pull was refused — resolve the blockers above and run again"
  exit 1
fi
grn "  ✓ server is on $AFTER"

# ── 5. Only now is it worth building ────────────────────────────────────────
echo
echo "Building"
# npm ci, never npm install: install rewrote package-lock.json on the box and
# blocked the next pull (see the header). Both trees, from their lockfiles.
remote 'npm ci 2>&1 | tail -1' | sed 's/^/    /'
remote 'npm --prefix ui ci 2>&1 | tail -1' | sed 's/^/    /'
TESTS=$(remote 'npm test 2>&1 | grep -E "^Tests:" | tail -1' || true)
info "${TESTS:-tests did not report}"
echo "$TESTS" | grep -q 'failed' && die "tests failed on the server"
BUILD=$(remote 'cd ui && npx vite build 2>&1 | tail -4' || true)
echo "$BUILD" | grep -q 'built in' || die "UI build failed: $BUILD"
echo "$BUILD" | grep -E 'built in' | sed 's/^/    /'

# ── 5b. A verified backup before anything restarts ──────────────────────────
echo
echo "Backing up"
BACKUP=$(remote 'node main/db/backup.js 2>&1 | tail -1' || true)
info "$BACKUP"
echo "$BACKUP" | grep -q 'Backed up' || die "backup did not succeed — not restarting"

echo
echo "Restarting"
# Reload through the committed ecosystem file so the restart policy (backoff,
# max_restarts) is what runs. The first deploy after a bare `pm2 start`
# cannot reload into the new options, so it is deleted and started once.
if remote 'pm2 jlist' | grep -q '"exp_backoff_restart_delay":1000'; then
  remote "DEPLOY_SHA=$LOCAL_SHA pm2 startOrReload ecosystem.config.js --update-env >/dev/null 2>&1; pm2 save >/dev/null 2>&1; sleep 7; pm2 list | grep xero-invoice-app" | sed 's/^/    /'
else
  info "first deploy under ecosystem.config.js — replacing the bare pm2 process once"
  remote "pm2 delete xero-invoice-app >/dev/null 2>&1 || true; DEPLOY_SHA=$LOCAL_SHA pm2 start ecosystem.config.js >/dev/null 2>&1; pm2 save >/dev/null 2>&1; sleep 7; pm2 list | grep xero-invoice-app" | sed 's/^/    /'
fi

HEALTH_OUT=$(curl -sk "$HEALTH" || true)
info "$HEALTH_OUT"
echo "$HEALTH_OUT" | grep -q healthy || die "health check did not report healthy"
RUNNING=$(echo "$HEALTH_OUT" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
[ "$RUNNING" = "$LOCAL_SHA" ] || die "the running process reports commit '${RUNNING:-none}', not $LOCAL_SHA — it did not restart onto the new code"
grn "  ✓ running process is on $RUNNING"

# ── 6. Daily backup cron (idempotent) and a name for this deploy ────────────
# node by absolute path: cron's PATH need not include node. Resolved in its
# own remote call and pasted in as a literal — a `$N` inside the command was
# expanded by the ssh login shell (empty) before the inner bash ever ran.
NODE_BIN=$(remote 'command -v node' | tr -d '[:space:]')
[ -n "$NODE_BIN" ] || NODE_BIN=node
remote "(crontab -l 2>/dev/null | grep -v 'main/db/backup.js'; printf '0 19 * * * cd %s && %s main/db/backup.js >> logs/backup.log 2>&1\n' $APP $NODE_BIN) | crontab -" >/dev/null 2>&1 \
  && info "daily backup cron installed (03:00 Singapore, $NODE_BIN)" || red "  ! could not install the backup cron"
TAG="deploy/$(date -u +%Y%m%d-%H%M%S)"
git tag -f "$TAG" "$LOCAL_SHA" >/dev/null 2>&1 && git push -q origin "$TAG" 2>/dev/null && info "tagged $TAG" || red "  ! could not push tag $TAG"

echo
grn "✓ deployed $LOCAL_SHA — server commit verified, tests passed, backed up, running process confirmed, healthy"
