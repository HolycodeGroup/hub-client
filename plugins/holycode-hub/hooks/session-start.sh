#!/bin/sh
# Holycode Hub — SessionStart hook (US-012 AC-02, BUG-042). Convenience only.
#
# Prints, in EVERY session:
#   1. the always-on git conventions (BUG-042) — so the agent carries them even
#      when the repo's AGENTS.md block is stale/missing and no story is claimed;
#   2. the link state read from the pointer file in the CURRENT working dir:
#        valid pointer       -> linked project id + Hub URL
#        no pointer file     -> "no Hub project in this directory — run /holycode-hub:init"
#        pointer without id  -> "pointer file is invalid — re-run /holycode-hub:init"
#   3. when linked: the project-rules line (HH-399) — the agent reads every
#      .project-management/rules/*.md before implementing; they win over Hub guidance;
#   4. when linked: a refresh warning if the repo's AGENTS.md Hub block is older
#      than (or missing next to) the block this plugin ships. The version is the
#      `<!-- holycode-hub:block-version: N -->` marker; an unversioned block = v1.
#
# Invariants (tested in __tests__/session-start.test.ts):
#   - NEVER makes a network call (plain file reads + sed; no HTTP/socket tools)
#   - ALWAYS exits 0 — a session is never blocked by this hook. Enforcement is
#     the work order minted by the Hub on every call, never anything on disk.
POINTER="${PWD}/.project-management/hub-pointer.md"
REPO_AGENTS="${PWD}/AGENTS.md"
PLUGIN_BLOCK="$(dirname "$0")/../agents/hub-workflow-section.md"
START_MARKER='<!-- holycode-hub:start -->'

print_conventions() {
  echo "holycode-hub git conventions (always on):"
  echo "- Conventional commit subjects (feat:, fix:, docs:, chore: ...), imperative, <= 72 chars."
  echo "- NO AI credits: never add Co-Authored-By: <AI> or \"Generated with ...\" trailers."
  echo "- Work on a <type>/<descriptor> branch and open a pull request."
  echo "- Never commit directly to main."
}

# Prints the block version of a file holding the Hub block: the marker's integer,
# "1" when the block is present without a marker, "" when the file or block is absent.
block_version() {
  [ -f "$1" ] && [ -r "$1" ] || return 0
  grep -qF "$START_MARKER" "$1" 2>/dev/null || return 0
  v=$(sed -n 's/^<!-- holycode-hub:block-version: \([0-9][0-9]*\) -->.*$/\1/p' "$1" 2>/dev/null | head -n 1)
  echo "${v:-1}"
}

# HH-399 — names the project's own rules so every session (claimed or not) loads them.
print_project_rules() {
  names=""
  for f in "${PWD}/.project-management/rules/"*.md; do
    [ -f "$f" ] || continue
    names="${names:+${names}, }$(basename "$f")"
  done
  if [ -n "$names" ]; then
    echo "holycode-hub: project rules in .project-management/rules/ (${names}) — read every file before implementing; on a conflict they win over Hub guidance"
  else
    echo "holycode-hub: no project rules in .project-management/rules/ yet — a claim delivers them once the team syncs some"
  fi
}

warn_if_block_stale() {
  shipped=$(block_version "$PLUGIN_BLOCK")
  [ -n "$shipped" ] || return 0
  current=$(block_version "$REPO_AGENTS")
  if [ -z "$current" ]; then
    echo "holycode-hub: AGENTS.md Hub block is missing, plugin ships v${shipped} — run /holycode-hub:init to refresh"
  elif [ "$current" -lt "$shipped" ] 2>/dev/null; then
    echo "holycode-hub: AGENTS.md Hub block is v${current}, plugin ships v${shipped} — run /holycode-hub:init to refresh"
  fi
  return 0
}

print_conventions

if [ ! -f "$POINTER" ]; then
  echo "holycode-hub: no Hub project in this directory — run /holycode-hub:init"
  exit 0
fi

PROJECT_ID=$(sed -n 's/^\*\*Project ID:\*\*[[:space:]]*//p' "$POINTER" 2>/dev/null | head -n 1 | tr -d '[:space:]')
HUB_URL=$(sed -n 's/^\*\*Hub URL:\*\*[[:space:]]*//p' "$POINTER" 2>/dev/null | head -n 1 | tr -d '[:space:]')

if [ -z "$PROJECT_ID" ]; then
  echo "holycode-hub: pointer file is invalid — re-run /holycode-hub:init"
  exit 0
fi

echo "holycode-hub: linked to project ${PROJECT_ID} at ${HUB_URL:-<hub-url>}"
print_project_rules
warn_if_block_stale
exit 0
