---
description: Link this working directory to a Hub project — create one as OWNER, or join an existing one by id
argument-hint: [project-id]
---
1. If `.project-management/hub-pointer.md` already carries a `**Project ID:**` line, report that id and stop — the directory is already linked.
2. Joining (a project id was passed as `$ARGUMENTS`, shared by the project owner): use that id as-is and make zero Hub calls.
3. Creating (no id passed): ask for the project name, type and stack, then call the `project_create` tool on the `holycode-hub` MCP server exactly once and take `project_id` and `pointer_file` from its result.
4. Write `.project-management/hub-pointer.md`: the returned `pointer_file.content` when creating, or the same layout when joining (`# Holycode Hub Pointer`, a blank line, `**Project ID:** <id>`, `**Hub URL:** <hub-url>`) — in both cases replace `<hub-url>` with the connected holycode-hub server's base URL.
5. Reply with the linked project id and Hub URL. Make no further Hub calls for this step.
