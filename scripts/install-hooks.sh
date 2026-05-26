#!/usr/bin/env bash
# Installs the Ventus git hooks into .git/hooks.
#
# We DON'T use `core.hooksPath` because it would require every contributor
# to know to run `git config core.hooksPath scripts/git-hooks` — symlinks
# are a one-time setup that survives `git pull` and never silently breaks
# when the source files change.
#
# Run from the repo root:  bash scripts/install-hooks.sh

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

HOOKS_SRC="$REPO_ROOT/scripts/git-hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DST" ]; then
  echo "install-hooks: $HOOKS_DST does not exist (not a git repo?)"
  exit 1
fi

for hook in pre-commit pre-push; do
  src="$HOOKS_SRC/$hook"
  dst="$HOOKS_DST/$hook"
  if [ ! -f "$src" ]; then
    echo "install-hooks: missing source $src"
    exit 1
  fi
  # Replace any existing hook (including the .sample default git ships).
  # We use a symlink so updates to scripts/git-hooks/* propagate without
  # re-running this installer.
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    rm -f "$dst"
  fi
  ln -s "$src" "$dst"
  chmod +x "$src"
  echo "install-hooks: $hook -> $src"
done

echo "install-hooks: done. Hooks active for this clone."
