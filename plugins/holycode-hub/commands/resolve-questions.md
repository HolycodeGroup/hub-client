---
description: Resolve the linked Hub project's open clarification questions — on the Hub, not a local file
argument-hint: [--priority Px | <question-id>]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Run `/hub:question-list` to see the open questions (it refreshes the local `.project-management/hub-questions.md` count marker); select the one(s) named in `$ARGUMENTS` (a question id or a `--priority` filter), or work through all open ones.
4. For each, decide the resolution with the user, then call the `project_question_resolve` tool on the `holycode-hub` MCP server once with `{ "project_id": "<that id>", "question_id": "<id>", "resolution": "<the decision>" }`; a `409` means it was already resolved (skip it), a `404` means the id is wrong.
5. Run `/hub:question-list` again to refresh the local count marker, and report which questions you resolved. Make no further Hub calls for this step.
