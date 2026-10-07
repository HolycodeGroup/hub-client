---
description: Regenerate this project's API documentation (Markdown + OpenAPI) from the actual backend code and report drift — following the Hub's endpoint-doc guidance
argument-hint: [scope] [--check]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Call the `work_guidance` tool on the `holycode-hub` MCP server with `{ "project_id": "<that id>", "question": "api-endpoints" }` and take the endpoint documentation shape from the returned answer (auth, request/response schema, the full status-code matrix, listed enum values, versioned paths), plus the conventions the project's own API docs already follow.
4. Read the project's ACTUAL backend routes/handlers and any existing API docs + OpenAPI spec — the code is the source of truth; never copy the old docs forward. Regenerate per-endpoint Markdown docs (and the OpenAPI spec when the project has one) for the scope in `$ARGUMENTS` (default: the whole API), reporting any drift between code, docs and spec. With `--check`, report drift only and write nothing.
5. Report the files written (or the drift found) ordered by endpoint. These are local docs in your repository. Make no further Hub calls for this step.
