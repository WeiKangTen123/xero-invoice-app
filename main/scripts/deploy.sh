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
#
# It also refuses to hang, and to fail quietly. When the Google login expired,
# gcloud sat on a reauth prompt nobody could see (its stderr went to
# /dev/null) and a deploy waited thirty minutes for it. So the logins are
# checked before anything else, every ssh call has a time limit and no
# terminal to prompt on, and an ssh call that fails stops the deploy instead
# of reading as empty output. A deploy that stops after the server has moved
# to the new commit says what state it left and prints the rollback.
set -euo pipefail

INSTANCE="${DEPLOY_INSTANCE:-xero-automation}"
ZONE="${DEPLOY_ZONE:-us-central1-a}"
APP="${DEPLOY_PATH:-/home/weika/xero-invoice-app}"
RUNAS="${DEPLOY_USER:-weika}"
HEALTH="${DEPLOY_HEALTH:-https://34-45-253-162.sslip.io/dashboard/health}"
SSH_TIMEOUT="${DEPLOY_SSH_TIMEOUT:-300}"     # seconds, for an ordinary call to the box
LONG_TIMEOUT="${DEPLOY_LONG_TIMEOUT:-1200}"  # npm ci, npm test and the UI build
STABLE_SECS="${DEPLOY_STABLE_SECS:-15}"      # how long the new process must stay up

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { red "✗ $*"; exit 1; }

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

TMP=$(mktemp -d)
LOCAL_SHA=""
BEFORE=""
STAGE=""   # set once the server's checkout has moved; read by on_exit

# Printed by on_exit when the deploy stops between moving the server's
# checkout and confirming the new process. That window is where a half-applied
# deploy lives: new code and dependencies on disk, the old process (or a
# failing new one) in memory, and nothing said about it. The rollback is the
# one in docs/RUNBOOK.md, pointed at the commit the server was on before.
partial_deploy_help() {
  echo
  if [ "$STAGE" = "merge" ]; then
    red "✗ The deploy stopped while moving the server's checkout from ${BEFORE:0:12} to ${LOCAL_SHA:0:12}, so it may be on either."
    info "npm run deploy -- --check says which."
  elif [ "$BEFORE" = "$LOCAL_SHA" ]; then
    red "✗ The deploy stopped partway. The server's checkout is on ${LOCAL_SHA:0:12}, as it was when this run started."
  else
    red "✗ The deploy stopped partway. The server's checkout is on ${LOCAL_SHA:0:12} (the new code); it was on ${BEFORE:0:12} before."
  fi
  case "$STAGE" in
    merge)
      info "Nothing was installed or restarted: the running process is the one from before"
      info "this deploy." ;;
    restart)
      info "pm2 was told to reload onto the new code and the new process was not confirmed:"
      info "it may be down, crash-looping, or still the old process. On the box: pm2 list;"
      info "pm2 logs xero-invoice-app --err --lines 100" ;;
    *)
      info "Nothing was restarted, so the running process is still the one from before this"
      info "deploy — but the files on disk, and node_modules if npm ci got that far, are the"
      info "new commit's. If pm2 restarts the process for any reason (a crash, a reboot) it"
      info "comes up on the new code, which has not passed this deploy's checks." ;;
  esac
  echo
  info "To finish: fix the cause and run npm run deploy again — it carries on from here."
  if [ -n "$BEFORE" ] && [ "$BEFORE" != "$LOCAL_SHA" ]; then
    info "To roll back to $BEFORE, on the box"
    info "(gcloud compute ssh $INSTANCE --zone=$ZONE, then as $RUNAS in $APP):"
    info "    git checkout $BEFORE"
    info "    npm ci && npm --prefix ui ci && npm run build:ui"
    info "    pm2 startOrReload ecosystem.config.js --update-env && pm2 save"
  else
    info "The server was already on this commit before this run, so there is no earlier"
    info "commit from this deploy to go back to: roll back to the last good deploy/<timestamp>"
    info "tag instead (git tag -l 'deploy/*')."
  fi
  info "Details: docs/RUNBOOK.md, 'A deploy that failed partway'."
}

on_exit() {
  local rc=$?
  rm -rf "$TMP" 2>/dev/null || true
  if [ "$rc" -ne 0 ] && [ -n "$STAGE" ]; then partial_deploy_help; fi
}
trap on_exit EXIT
# remote() ends the whole deploy from inside $( … ) by signalling this shell;
# these turn that, and Ctrl-C, into an ordinary failing exit so on_exit runs
# with a non-zero status.
trap 'exit 143' TERM
trap 'exit 130' INT

# GNU timeout: in Git Bash and on Linux it is `timeout`; on a Mac it comes with
# coreutils as `gtimeout`.
TIMEOUT=$(command -v timeout || command -v gtimeout || true)
[ -n "$TIMEOUT" ] || die "this script needs GNU timeout (on a Mac: brew install coreutils)"

# Every command on the box goes through here, optionally with a time limit in
# seconds as $2. stdin is /dev/null and --quiet is set, so nothing can wait on
# a prompt, and `timeout` bounds whatever else can hang. Output goes to files
# rather than a pipe: an ssh client that outlives a killed gcloud would hold a
# pipe open, and the caller would wait for it anyway.
#
# If gcloud or the ssh client itself fails — it timed out, OpenSSH's 255, a
# gcloud ERROR line of its own, or one of PuTTY's transport errors (on Windows
# gcloud runs plink, which exits 1 for those, the same code as a remote
# command that failed) — the deploy stops here, even from inside $( … ) or
# behind `|| true`. Read as empty output, an unreachable server looks like a
# server with nothing to report. Any other status is the remote command's own,
# returned as before.
#
# A temporary failure of Google's own API — gcloud could not even look the VM
# up ("Could not fetch resource", a 5xx page saying to try again in 30
# seconds) — is retried twice before giving up: the command never reached the
# box, so running it again cannot do anything twice. A deploy stopped on one
# such 502 on 2026-10-07.
remote() {
  local limit="${2:-$SSH_TIMEOUT}" rc attempt start
  for attempt in 1 2 3; do
    rc=0; start=$SECONDS
    "$TIMEOUT" --foreground -k 10 "$limit" \
      gcloud compute ssh "$INSTANCE" --zone="$ZONE" --quiet \
        --command="sudo -u $RUNAS -H bash -lc \"cd $APP && $1\"" \
      </dev/null >"$TMP/out" 2>"$TMP/err" || rc=$?
    [ "$rc" -ne 0 ] && google_api_hiccup && [ "$attempt" -lt 3 ] || break
    info "Google's API had a temporary error (attempt $attempt); trying again in $((attempt * 20))s" >&2
    sleep $((attempt * 20))
  done
  if [ "$rc" -eq 124 ] || { [ "$rc" -eq 137 ] && [ $((SECONDS - start)) -ge "$limit" ]; }; then
    unreachable "no answer from the server within ${limit}s" "$1"
  elif [ "$rc" -eq 255 ] || ssh_itself_failed; then
    unreachable "gcloud compute ssh failed (exit $rc)" "$1"
  fi
  cat "$TMP/out"
  return "$rc"
}

# True only when gcloud failed before connecting to the VM because Google's API
# answered with a server error. An authentication, permission or network
# failure, or anything from the box itself, is not retried.
google_api_hiccup() {
  grep -q 'Could not fetch resource' "$TMP/err" 2>/dev/null || return 1
  grep -Eq '\b50[0234]\b|temporary error|try again|backendError|[Ii]nternal error' "$TMP/err" 2>/dev/null
}

ssh_itself_failed() {
  awk '/^ERROR: (\(gcloud|gcloud crashed)/ && !/exited with return code \[[0-9]+\]/ { bad = 1 }
       /^FATAL ERROR: (Network error|Remote side|Server unexpectedly|No supported authentication|Cannot confirm|Host does not exist)/ { bad = 1 }
       END { exit !bad }' "$TMP/err"
}

# To stderr, which $( … ) does not capture, then signal the main shell: an
# `exit` here would only leave the subshell a $( … ) or a pipe runs this in.
unreachable() {
  {
    red "✗ $1, while running: $2"
    tail -n 8 "$TMP/err" 2>/dev/null | tr -d '\r' | sed 's/^/      /'
    info "check the VM is running and that 'gcloud compute ssh $INSTANCE --zone=$ZONE' works by hand"
  } >&2 || true
  kill -TERM "$$"
  exit 1
}

# ── 0. Logins, before anything can hang on them ─────────────────────────────
# Asking for an access token with no stdin makes an expired login fail at once
# (gcloud will not try to reauthenticate without a terminal) instead of waiting
# on a prompt inside an ssh call. gh is checked for the same reason: a
# logged-out gh made the CI gate below report "no CI run found" and carry on.
command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed (or not on PATH)"
"$TIMEOUT" --foreground -k 5 60 gcloud auth print-access-token </dev/null >/dev/null 2>&1 \
  || die "gcloud login expired — run: gcloud auth login"
if [ "$CHECK_ONLY" != "1" ] && [ "${SKIP_CI:-0}" != "1" ]; then
  command -v gh >/dev/null 2>&1 \
    || die "gh (GitHub CLI) is not installed, so CI cannot be checked — install it, or run with SKIP_CI=1 to deploy without CI"
  "$TIMEOUT" --foreground -k 5 60 gh auth status --hostname github.com </dev/null >/dev/null 2>&1 \
    || die "gh is not logged in — run: gh auth login (or SKIP_CI=1 to deploy without CI)"
fi

# ── 1. Local must be clean, pushed, and exactly origin/master ───────────────
# Deploying while local changes are uncommitted ships something nobody can
# reproduce from the repository. HEAD must also BE origin/master, not merely
# be contained in it: the server is moved to exactly this commit, and CI
# below is checked for exactly this commit, so a local checkout that is
# behind would deploy something other than master's tip without saying so.
LOCAL_SHA=$(git rev-parse HEAD)
echo "Local"
info "commit  $(git log --oneline -1)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no | sed 's/^/    /'
  die "Uncommitted changes. Commit or stash before deploying."
fi

git fetch -q origin
AHEAD=$(git rev-list --count origin/master..HEAD)
BEHIND=$(git rev-list --count HEAD..origin/master)
if [ "$AHEAD" -gt 0 ] && [ "$BEHIND" -gt 0 ]; then
  die "Local has diverged from origin/master ($AHEAD local, $BEHIND remote commit(s)). Rebase or merge, push, then deploy."
elif [ "$AHEAD" -gt 0 ]; then
  git log origin/master..HEAD --oneline | sed 's/^/    /'
  die "Local commits are not pushed. The server pulls from origin."
elif [ "$BEHIND" -gt 0 ]; then
  git log HEAD..origin/master --oneline | sed 's/^/    /'
  [ "$CHECK_ONLY" = "1" ] || die "Local is $BEHIND commit(s) behind origin/master. Pull, then deploy — the server is moved to exactly the local commit."
  red "  ! local is $BEHIND commit(s) behind origin/master"
else
  grn "  ✓ clean, pushed, and at origin/master"
fi

# ── 1b. CI must be green for this commit ────────────────────────────────────
# The route suites are flaky on a Mac (see main/scripts/jest.setup.js); the
# GitHub Actions run on Node 22 is the reliable verdict. Waits if it is still
# running. SKIP_CI=1 overrides; a missing run (workflow not on master yet) is
# reported and allowed. gh is known to be installed and logged in by now.
CI_NOTE="CI skipped (SKIP_CI=1)"
if [ "$CHECK_ONLY" != "1" ] && [ "${SKIP_CI:-0}" != "1" ]; then
  ci_run() { gh run list --commit "$LOCAL_SHA" --workflow ci --json databaseId -q '.[0].databaseId' </dev/null 2>/dev/null || true; }
  RUN_ID=$(ci_run)
  if [ -z "$RUN_ID" ]; then sleep 20; RUN_ID=$(ci_run); fi
  if [ -n "$RUN_ID" ]; then
    info "CI run $RUN_ID — waiting for it"
    if gh run watch "$RUN_ID" --exit-status </dev/null >/dev/null 2>&1; then
      grn "  ✓ CI green"
      CI_NOTE="CI green"
    else
      die "CI is red for $LOCAL_SHA — fix it before deploying (SKIP_CI=1 to override)"
    fi
  else
    red "  ! no CI run found for $LOCAL_SHA — continuing without it"
    CI_NOTE="no CI run found"
  fi
fi

# ── 2. What is the server actually running? ─────────────────────────────────
echo
echo "Server"
BEFORE=$(remote 'git rev-parse HEAD' | tr -d '[:space:]') \
  || die "could not read the server's commit: $(tail -n 3 "$TMP/err" | tr -d '\r')"
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
  info "behind by: $(remote "git log --oneline ${BEFORE}..${LOCAL_SHA} 2>/dev/null | wc -l" | tr -d '[:space:]') commit(s)"
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
#
# Only a file the incoming commits ADD can collide with an untracked file on
# the box; a tracked file that changes is in nobody's way. The list comes from
# the local repository, which has both commits, and the box is asked about up
# to 50 paths per ssh call. This used to be one or two ssh calls per changed
# file — around a hundred for a week of commits — and one passing 502 from
# Google's API on any of them stopped the deploy.
if git cat-file -e "${BEFORE}^{commit}" 2>/dev/null; then
  ADDED=$(git diff --name-only --diff-filter=A "$BEFORE" "$LOCAL_SHA")
else
  ADDED=$(remote "git fetch -q origin 2>/dev/null; git diff --name-only --diff-filter=A HEAD ${LOCAL_SHA} 2>/dev/null" || true)
fi
CLASH=""
if [ -n "$ADDED" ]; then
  # Paths are passed to the box inside single quotes; one containing a quote
  # cannot be, so it is not guessed at.
  grep -q "'" <<<"$ADDED" && die "an incoming path contains a quote character; check the box for untracked files in the way by hand"
  BATCH=""; N=0
  check_batch() {
    [ -z "$BATCH" ] && return 0
    CLASH="$CLASH$(remote "ls -d --$BATCH 2>/dev/null || true")"$'\n'
    BATCH=""; N=0
  }
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    BATCH="$BATCH '$f'"; N=$((N + 1))
    [ "$N" -ge 50 ] && check_batch
  done <<< "$ADDED"
  check_batch
  CLASH=$(printf '%s\n' "$CLASH" | tr -d '\r' | sed '/^[[:space:]]*$/d')
fi
if [ -n "$CLASH" ]; then
  red "  ✗ untracked files on the server are in the way of the incoming commit:"
  printf '%s\n' "$CLASH" | sed 's/^/        /'
  die "remove them on the server, then run again"
fi

# Fast-forward to exactly the commit checked above, not to whatever master's
# tip is by now: `git pull origin master` would ship a commit pushed after CI
# was checked for this one. From here until the new process is confirmed, a
# failure leaves the server half-deployed, and on_exit says so.
STAGE=merge
PULL=$(remote "git fetch -q origin 2>&1 && git merge --ff-only ${LOCAL_SHA} 2>&1 | tail -3" || true)
echo "$PULL" | sed 's/^/    /'

# ── 4. The check that was missing ───────────────────────────────────────────
AFTER=$(remote 'git rev-parse HEAD' | tr -d '[:space:]') \
  || die "could not read the server's commit after the merge: $(tail -n 3 "$TMP/err" | tr -d '\r')"
if [ "$AFTER" != "$LOCAL_SHA" ]; then
  [ "$AFTER" = "$BEFORE" ] && STAGE=""   # nothing moved, so nothing to roll back
  echo
  red "✗ DEPLOY DID NOT APPLY"
  info "expected $LOCAL_SHA"
  info "server   $AFTER"
  info "the merge was refused — resolve the blockers above and run again"
  exit 1
fi
STAGE=build
grn "  ✓ server is on $AFTER"

# ── 5. Only now is it worth building ────────────────────────────────────────
echo
echo "Building"
# npm ci, never npm install: install rewrote package-lock.json on the box and
# blocked the next pull (see the header). Both trees, from their lockfiles.
# Each install's exit status decides, not its last line: `npm ci | tail -1`
# reported tail's success, so a failed install went on to test and build
# against whatever node_modules it had left. The `\$?` reaches the box's
# bash as `$?` — unescaped, the ssh login shell would expand it first.
installed() {  # $1 = what ran, $2 = its log on the box, $3 = "exit=N" then the log's tail
  local code
  code=$(printf '%s\n' "$3" | sed -n 's/^exit=//p')
  if [ "$code" = "0" ]; then
    printf '%s\n' "$3" | sed '1d; /^[[:space:]]*$/d' | tail -n 1 | sed 's/^/    /'
  else
    printf '%s\n' "$3" | sed '1d; s/^/      /'
    die "$1 failed on the server (exit ${code:-unknown}) — full log on the box: $APP/$2"
  fi
}
ROOT_CI=$(remote 'mkdir -p logs && npm ci >logs/deploy-npm-ci.log 2>&1; echo exit=\$?; tail -n 15 logs/deploy-npm-ci.log' "$LONG_TIMEOUT" || true)
installed "npm ci" logs/deploy-npm-ci.log "$ROOT_CI"
UI_CI=$(remote 'mkdir -p logs && npm --prefix ui ci >logs/deploy-ui-npm-ci.log 2>&1; echo exit=\$?; tail -n 15 logs/deploy-ui-npm-ci.log' "$LONG_TIMEOUT" || true)
installed "npm --prefix ui ci" logs/deploy-ui-npm-ci.log "$UI_CI"

# The exit status of npm test, and a summary that says what ran. Grepping the
# summary for 'failed' passed a run that printed no summary at all (it crashed
# or was killed), and a suite that fails to load is counted only under "Test
# Suites: 1 failed" while "Tests:" still says every test that ran passed.
TEST_OUT=$(remote 'mkdir -p logs && npm test >logs/deploy-test.log 2>&1; echo exit=\$?; grep -e ^Test.Suites: -e ^Tests: logs/deploy-test.log | tail -n 2' "$LONG_TIMEOUT" || true)
TEST_EXIT=$(printf '%s\n' "$TEST_OUT" | sed -n 's/^exit=//p')
TEST_SUMMARY=$(printf '%s\n' "$TEST_OUT" | sed -n 's/^Tests:[[:space:]]*//p')
printf '%s\n' "$TEST_OUT" | sed -n 's/^\(Test\)/    \1/p'
if [ "$TEST_EXIT" != "0" ] || [ -z "$TEST_SUMMARY" ]; then
  remote 'tail -n 40 logs/deploy-test.log' | sed 's/^/      /' || true
  die "tests did not pass on the server (npm test exit ${TEST_EXIT:-unknown}, ${TEST_SUMMARY:-no Tests: summary}) — full log on the box: $APP/logs/deploy-test.log"
fi
BUILD=$(remote 'cd ui && npx vite build 2>&1 | tail -4' "$LONG_TIMEOUT" || true)
echo "$BUILD" | grep -q 'built in' || die "UI build failed: $BUILD"
echo "$BUILD" | grep -E 'built in' | sed 's/^/    /'

# ── 5b. A verified backup before anything restarts ──────────────────────────
echo
echo "Backing up"
# The whole output, not its last line. Once more than KEEP_COUNT backups exist
# the script prunes AFTER it reports "Backed up", so the last line was "Pruned
# old backup …" and a successful backup read as a failure, which left the
# server pulled and built but never restarted.
BACKUP=$(remote 'node main/db/backup.js 2>&1' 600 || true)
echo "$BACKUP" | sed 's/^/    /'
echo "$BACKUP" | grep -q 'Backed up' || die "backup did not succeed — not restarting"

echo
echo "Restarting"
# Reload through the committed ecosystem file so the restart policy (backoff,
# max_restarts) is what runs. The first deploy after a bare `pm2 start`
# cannot reload into the new options, so it is deleted and started once.
# (Captured, then searched: grep -q on a pipe can stop reading early, and
# under pipefail the writer's SIGPIPE would read as "no ecosystem file yet".)
STAGE=restart
PM2_LIST=$(remote 'pm2 jlist' || true)
if grep -q '"exp_backoff_restart_delay":1000' <<<"$PM2_LIST"; then
  remote "pm2 startOrReload ecosystem.config.js --update-env >/dev/null 2>&1; pm2 save >/dev/null 2>&1; sleep 7; pm2 list | grep xero-invoice-app" | sed 's/^/    /'
else
  info "first deploy under ecosystem.config.js — replacing the bare pm2 process once"
  remote "pm2 delete xero-invoice-app >/dev/null 2>&1 || true; pm2 start ecosystem.config.js >/dev/null 2>&1; pm2 save >/dev/null 2>&1; sleep 7; pm2 list | grep xero-invoice-app" | sed 's/^/    /'
fi

# A few tries, each with a time limit: one curl straight after the reload could
# catch the process still starting, and a curl with no --max-time could hang.
HEALTH_OUT=""; RUNNING=""
for try in 1 2 3 4 5 6; do
  HEALTH_OUT=$(curl -sk --max-time 10 "$HEALTH" || true)
  RUNNING=$(echo "$HEALTH_OUT" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
  if echo "$HEALTH_OUT" | grep -q '"status":"healthy"' && [ "$RUNNING" = "$LOCAL_SHA" ]; then break; fi
  if [ "$try" -lt 6 ]; then sleep 5; fi
done
info "${HEALTH_OUT:-no response from $HEALTH}"
# "unhealthy" contains "healthy": match the status field itself, now that the
# health check can really report a failing database (503, status "unhealthy").
echo "$HEALTH_OUT" | grep -q '"status":"healthy"' || die "health check did not report healthy"
[ "$RUNNING" = "$LOCAL_SHA" ] || die "the running process reports commit '${RUNNING:-none}', not $LOCAL_SHA — it did not restart onto the new code"
grn "  ✓ running process is on $RUNNING"

# Healthy once is not up: a process that crashes a few seconds after boot
# answers the first health check, then pm2 restarts it, over and over. pm2's
# own restart counter, read twice, says whether it stayed up. The JSON is read
# with node here rather than on the box, where the script would need quoting
# through three shells.
pm2_state() {  # prints "<status> <restarts>" for xero-invoice-app
  remote 'pm2 jlist' | tr -d '\r' | node -e '
    let s = "";
    process.stdin.on("data", d => { s += d; }).on("end", () => {
      let app;
      for (const line of s.split("\n").reverse()) {
        if (!line.trim().startsWith("[")) continue;
        try { app = JSON.parse(line).find(p => p.name === "xero-invoice-app"); break; } catch (e) { /* not the list */ }
      }
      console.log(app ? `${app.pm2_env.status} ${app.pm2_env.restart_time}` : "missing -");
    });'
}
read -r STATE_A RESTARTS_A <<<"$(pm2_state || echo 'unknown -')"
sleep "$STABLE_SECS"
read -r STATE_B RESTARTS_B <<<"$(pm2_state || echo 'unknown -')"
if [ "$STATE_B" != "online" ] || [ "$RESTARTS_A" = "-" ] || [ "$RESTARTS_B" != "$RESTARTS_A" ]; then
  die "pm2 reports xero-invoice-app '$STATE_B', restarts ${RESTARTS_A} → ${RESTARTS_B} over ${STABLE_SECS}s — it is not staying up (on the box: pm2 logs xero-invoice-app --err --lines 100)"
fi
grn "  ✓ still online ${STABLE_SECS}s later, no restarts"
STAGE=""   # the new process is confirmed; nothing below can leave a half-deploy

# ── 6. Daily backup cron (idempotent) and a name for this deploy ────────────
# node by absolute path: cron's PATH need not include node. Resolved in its
# own remote call and pasted in as a literal — a `$N` inside the command was
# expanded by the ssh login shell (empty) before the inner bash ever ran.
NOTES=""
NODE_BIN=$(remote 'command -v node' | tr -d '[:space:]' || true)
[ -n "$NODE_BIN" ] || NODE_BIN=node
remote "(crontab -l 2>/dev/null | grep -v 'main/db/backup.js'; printf '0 19 * * * cd %s && %s main/db/backup.js >> logs/backup.log 2>&1\n' $APP $NODE_BIN) | crontab -" >/dev/null 2>&1 \
  && info "daily backup cron installed (03:00 Singapore, $NODE_BIN)" \
  || { red "  ! could not install the backup cron"; NOTES="$NOTES; backup cron NOT installed"; }
TAG="deploy/$(date -u +%Y%m%d-%H%M%S)"
{ git tag -f "$TAG" "$LOCAL_SHA" >/dev/null 2>&1 && git push -q origin "$TAG" 2>/dev/null && info "tagged $TAG"; } \
  || { red "  ! could not push tag $TAG"; NOTES="$NOTES; tag NOT pushed"; }

echo
grn "✓ deployed $LOCAL_SHA — $CI_NOTE, server commit verified, tests passed ($TEST_SUMMARY), backed up, running process confirmed, healthy and stable for ${STABLE_SECS}s$NOTES"
