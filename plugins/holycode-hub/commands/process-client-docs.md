---
description: Extract requirements from client documents and author them into the linked Hub project's backlog — on the Hub, not local files
argument-hint: [input-path]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Run `/holycode-hub:guidance story template` for the story shape, then read the client documents under `.project-management/input/client-input/` (or the path in `$ARGUMENTS`) and extract requirements into candidate phase/epic/story items — English only, replacing any personal names with role labels; where a requirement is ambiguous, record it as an open question via `/holycode-hub:add-scope` rather than guessing.
4. Run `/holycode-hub:status` first and skip any candidate whose title already exists under the same epic (idempotent — re-running never duplicates a story).
5. For each remaining candidate, call the `project_story_add` tool on the `holycode-hub` MCP server once with `{ "project_id": "<that id>", "phase": {...}, "epic": {...}, "story": {...} }`; show the batch to the user for confirmation before the first write.
6. Report how many stories were authored and any open questions recorded. Make no further Hub calls for this step.
