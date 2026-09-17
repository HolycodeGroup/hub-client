#!/bin/sh
# Holycode Hub — SessionStart hook (US-012 AC-02). Convenience only.
#
# Reads the pointer file in the CURRENT working directory and prints the link
# state so the agent (and the developer) know which Hub project this directory
# belongs to. Three outcomes, one line each:
#   valid pointer       -> linked project id + Hub URL
#   no pointer file     -> "no Hub project in this directory — run /hub:init"
#   pointer without id  -> "pointer file is invalid — re-run /hub:init"
#
# Invariants (tested in __tests__/session-start.test.ts):
#   - NEVER makes a network call (plain file read + sed; no curl/wget/fetch)
#   - ALWAYS exits 0 — a session is never blocked by this hook. Enforcement is
#     the work order minted by the Hub on every call, never anything on disk.
POINTER="${PWD}/.project-management/hub-pointer.md"

if [ ! -f "$POINTER" ]; then
  echo "holycode-hub: no Hub project in this directory — run /hub:init"
  exit 0
fi

PROJECT_ID=$(sed -n 's/^\*\*Project ID:\*\*[[:space:]]*//p' "$POINTER" | head -n 1 | tr -d '[:space:]')
HUB_URL=$(sed -n 's/^\*\*Hub URL:\*\*[[:space:]]*//p' "$POINTER" | head -n 1 | tr -d '[:space:]')

if [ -z "$PROJECT_ID" ]; then
  echo "holycode-hub: pointer file is invalid — re-run /hub:init"
  exit 0
fi

echo "holycode-hub: linked to project ${PROJECT_ID} at ${HUB_URL:-<hub-url>}"
exit 0
