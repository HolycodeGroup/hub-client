---
description: Link this working directory to a Hub project — create one as OWNER, or join an existing one by id
argument-hint: [project-id]
---
1. If `.project-management/hub-pointer.md` already carries a `**Project ID:**` line, report that id, do step 5, then stop — the directory is already linked.
2. Joining (a project id was passed as `$ARGUMENTS`, shared by the project owner): use that id as-is and make zero Hub calls.
3. Creating (no id passed): ask for the project name, type and stack, then call the `project_create` tool on the `holycode-hub` MCP server exactly once and take `project_id` and `pointer_file` from its result.
4. Write `.project-management/hub-pointer.md`: the returned `pointer_file.content` when creating, or the same layout when joining (`# Holycode Hub Pointer`, a blank line, `**Project ID:** <id>`, `**Hub URL:** <hub-url>`) — in both cases replace `<hub-url>` with the connected holycode-hub server's base URL.
5. Ensure this repository's `AGENTS.md` carries the Hub workflow section: copy the contents of `${CLAUDE_PLUGIN_ROOT}/agents/hub-workflow-section.md` into `AGENTS.md` — create the file with that content if missing; if it exists, replace everything between the `<!-- holycode-hub:start -->` and `<!-- holycode-hub:end -->` markers (append the whole block when the markers are absent); never change text outside the markers.
6. Reply with the linked project id and Hub URL. Make no further Hub calls for this step.
