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
  info "discarding the server's local edits to tracked files"
  remote "git checkout -- \$(git status --porcelain --untracked-files=no | awk '{print \$2}' | tr '\n' ' ')" >/dev/null || true
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
remote 'npm install 2>&1 | tail -1' | sed 's/^/    /'
TESTS=$(remote 'npm test 2>&1 | grep -E "^Tests:" | tail -1' || true)
info "${TESTS:-tests did not report}"
echo "$TESTS" | grep -q 'failed' && die "tests failed on the server"
remote 'cd ui && npx vite build 2>&1 | grep -E "built in"' | sed 's/^/    /'

echo
echo "Restarting"
remote 'pm2 restart xero-invoice-app --update-env >/dev/null 2>&1; sleep 7; pm2 list | grep xero-invoice-app' | sed 's/^/    /'

HEALTH_OUT=$(curl -sk "$HEALTH" || true)
info "$HEALTH_OUT"
echo "$HEALTH_OUT" | grep -q healthy || die "health check did not report healthy"

echo
grn "✓ deployed $LOCAL_SHA — server commit verified, tests passed, healthy"
