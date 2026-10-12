---
description: Show the linked Hub project's live status board
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Call the `project_status` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>" }`.
4. If the Hub answers 403 `FORBIDDEN_RESOURCE`, tell the user the same "No Hub project in this directory — run /holycode-hub:init" message (the pointer names a project this account cannot see) and stop.
5. First show **Ready to claim** from `result.ready`, in the Hub's order: one line per entry with its `key`, `title`, `priority` and `points`, and the command `/holycode-hub:claim <key>` (note that `/holycode-hub:claim` with no argument takes the first one). When `result.ready` is empty, say nothing is ready yet and list each `result.waiting` entry's key with the keys and statuses it is `blocked_by`. Never pick or suggest a story yourself.
6. Then render the board as a compact table — phases, epics, and stories with their **key** (never the long `id`), title, status, points and `dep_keys` — then the summary, exactly as returned (OWNER and DEVELOPER receive the same board).
7. Make no further Hub calls for this step.
