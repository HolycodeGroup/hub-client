---
description: Show the linked Hub project's live status board
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Call the `project_status` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>" }`.
4. If the Hub answers 403 `FORBIDDEN_RESOURCE`, tell the user the same "No Hub project in this directory — run /hub:init" message (the pointer names a project this account cannot see) and stop.
5. Render the returned board as a compact table — phases, epics, stories with status and points, then the summary — exactly as returned (a DEVELOPER receives titles, points and status only).
6. Make no further Hub calls for this step.
