---
description: Plan the linked Hub project from a client brief — scope, phased backlogs, technologies, constraints
argument-hint: <path-to-brief>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Read the brief file at `$ARGUMENTS` (ask for the path if none was given) and pass its full text unchanged — never summarise or rewrite the brief.
4. Call the `project_plan` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "brief": "<the brief's full text>" }`.
5. Report what the Hub returned (summary and open questions). The phased backlog now lives on the Hub — view it with `/holycode-hub:status`, never a local file; `/holycode-hub:export` materialises scope, technologies and constraints only.
6. Make no further Hub calls for this step.
