---
description: List the linked Hub project's open clarification questions — the shared registry, not a local file
argument-hint: [open|resolved|all]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop. If any Hub call in this command answers 403 `FORBIDDEN_CREDENTIAL_ORG`, this sign-in belongs to a different organisation than this directory's project: show the Hub's message verbatim (it names the organisation), tell the user to sign in to the Hub again and choose that organisation on the Hub's organisation page (reconnect the `holycode-hub` MCP server so its sign-in opens — in Claude Code: `/mcp` → `holycode-hub` → re-authenticate), and stop — never repeat the call or switch to another project.
3. Call the `project_question_list` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "status": "<open|resolved|all, default open>" }`. The `result` is a JSON object with `questions` and `open_count`; if it arrives as a text content block, parse that text as JSON first.
4. Present each question (category, priority, text, default, impact, status). Then write `.project-management/hub-questions.md` as a POINTER ONLY — the single line `**Open questions:** <open_count> on the Hub — run /holycode-hub:resolve-questions` — never the question content; delete any legacy `.project-management/input/open-questions.md`.
5. Make no further Hub calls for this step.
