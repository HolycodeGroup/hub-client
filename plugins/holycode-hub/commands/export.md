---
description: Export the linked Hub project's own artifacts (scope, technologies, constraints, rules) as files — the backlog stays on the Hub
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Call the `project_export` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>" }`. It returns scope, technologies, constraints and the project's own rules — NOT the phased backlog (the story list lives on the Hub; view it with `/hub:status`).
4. Write every returned file to its `path` relative to the working directory (create directories as needed, overwrite existing files) and list what was written.
5. Make no further Hub calls for this step.
