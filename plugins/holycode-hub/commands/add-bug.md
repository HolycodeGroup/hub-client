---
description: File a bug into the linked Hub project's backlog — authored on the Hub, not a local file
argument-hint: <bug description>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Run `/holycode-hub:guidance bug-report shape` to get the bug shape, then build from `$ARGUMENTS` the input `{ "phase": { "name", "priority" }, "epic": { "name", "priority" }, "bug": { "title", "severity", "description", "priority" } }`; show it to the user for confirmation before writing.
4. Call the `project_bug_add` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", ...the built phase/epic/bug }`.
5. Report the returned story_id / epic_id / phase_id. Make no further Hub calls for this step.
