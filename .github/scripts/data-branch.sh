#!/usr/bin/env bash
# Prepare or publish the `pipeline-data` branch that holds the pipeline's JSON
# state. The branch is kept as ONE squashed commit (history of models and
# calibrators lives inside the versioned JSON), so a run every 10 minutes
# doesn't grow the repository without bound.
#   data-branch.sh prepare   -> ./pipeline-data (worktree) with ./pipeline-data/data
#   data-branch.sh publish "message"
set -euo pipefail
BRANCH=pipeline-data
DIR=pipeline-data
git config --global user.name "mlb-pipeline[bot]"
git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"

case "${1:-}" in
  prepare)
    if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
      git fetch --depth=1 origin "$BRANCH"
      git worktree add --detach "$DIR" FETCH_HEAD
    else
      git worktree add --detach "$DIR"
      (cd "$DIR" && git rm -rq . && git clean -fdq)
    fi
    mkdir -p "$DIR/data"
    ;;
  publish)
    msg="${2:-pipeline update}"
    cd "$DIR"
    cat > README.md <<'MD'
# pipeline-data

Machine-written output of the MLB Predictor pipeline (`pipeline/`), refreshed by
GitHub Actions. Read by the dashboard from raw.githubusercontent.com. This
branch is force-replaced by a single commit on every run; model, calibrator,
and experiment history is versioned inside the JSON files themselves.
MD
    git checkout -q --orphan "publish-$$"
    git add -A
    git commit -qm "$msg"
    for i in 1 2 3 4; do
      if git push -f origin "HEAD:refs/heads/$BRANCH"; then exit 0; fi
      sleep $((2 ** i))
    done
    echo "push failed" >&2; exit 1
    ;;
  *) echo "usage: data-branch.sh prepare|publish [message]" >&2; exit 2 ;;
esac
