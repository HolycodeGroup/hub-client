---
description: Estimate the linked Hub project — points, team hours and AI hours per phase and priority
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Call the `project_estimate` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>" }`.
4. Present the returned totals and the per-phase / per-priority rows as a table, keeping the `calibration` marker visible exactly as returned.
5. Make no further Hub calls for this step.
