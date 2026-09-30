---
description: Plan the linked Hub project from a client brief — scope, phased backlogs, technologies, constraints
argument-hint: <path-to-brief>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Take the brief file path from `$ARGUMENTS` (ask for it if none was given). If it is a document (PDF/DOCX) or a large text/markdown file, UPLOAD it instead of extracting locally: base64-encode the raw bytes and call the `project_document_upload` tool on the `holycode-hub` MCP server once with `{ "project_id": "<that id>", "filename": "<name.ext>", "content_base64": "<bytes>" }`; on `status: "FAILED"` report the `failure_reason` and stop (convert PPTX/images to PDF and retry). Otherwise, for a small plain-text/markdown brief you may skip the upload and pass the text inline.
4. Call the `project_plan` tool on the `holycode-hub` MCP server exactly once — with `{ "project_id": "<that id>", "upload_id": "<the id from step 3>" }` when you uploaded, or `{ "project_id": "<that id>", "brief": "<the brief's full text>" }` for a small inline brief. Never both.
5. Report what the Hub returned (summary and open questions). The phased backlog now lives on the Hub — view it with `/holycode-hub:status`, never a local file; `/holycode-hub:export` materialises scope, technologies and constraints only.
6. Make no further Hub calls for this step.
