---
description: List the linked Hub project's open clarification questions — the shared registry, not a local file
argument-hint: [open|resolved|all]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Call the `project_question_list` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "status": "<open|resolved|all, default open>" }`. The `result` is a JSON object with `questions` and `open_count`; if it arrives as a text content block, parse that text as JSON first.
4. Present each question (category, priority, text, default, impact, status). Then write `.project-management/hub-questions.md` as a POINTER ONLY — the single line `**Open questions:** <open_count> on the Hub — run /hub:resolve-questions` — never the question content; delete any legacy `.project-management/input/open-questions.md`.
5. Make no further Hub calls for this step.
