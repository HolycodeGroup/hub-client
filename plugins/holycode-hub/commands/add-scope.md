---
description: Add a story to the linked Hub project's backlog — authored on the Hub, not a local file
argument-hint: <story description>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Run `/holycode-hub:guidance story template` to get the story shape (persona-form story, testable acceptance criteria, Fibonacci estimate), then build from `$ARGUMENTS` the input `{ "phase": { "name", "priority" }, "epic": { "name", "priority" }, "story": { "title", "description", "acceptance_criteria", "priority", "points" } }`; show it to the user for confirmation before writing.
4. Call the `project_story_add` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", ...the built phase/epic/story }`.
5. Report the returned story_id / epic_id / phase_id. Make no further Hub calls for this step.
