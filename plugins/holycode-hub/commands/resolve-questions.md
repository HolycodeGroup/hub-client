---
description: Resolve the linked Hub project's open clarification questions — on the Hub, not a local file
argument-hint: [--priority Px | <question-id>]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Run `/holycode-hub:question-list` to see the open questions (it refreshes the local `.project-management/hub-questions.md` count marker); select the one(s) named in `$ARGUMENTS` (a question id or a `--priority` filter), or work through all open ones.
4. For each, decide the resolution with the user, then call the `project_question_resolve` tool on the `holycode-hub` MCP server once with `{ "project_id": "<that id>", "question_id": "<id>", "resolution": "<the decision>" }`; a `409` means it was already resolved (skip it), a `404` means the id is wrong.
5. **Apply amendments** — call the `project_status` tool once with `{ "project_id": "<that id>" }`, list every story an answer contradicts (e.g. a changed expiry, a removed action or status), and show a before/after per story; ask ONE confirmation for the whole batch ("apply amendments").
6. On yes, call the `project_story_update` tool once per affected story with `{ "project_id": "<that id>", "story_id": "<id>", "version": <its version from that project_status>, ...only the changed fields }` (text / list fields replace the stored value, so write them in full); a `409` means that story changed — re-fetch `project_status` and re-show it, never blind-retry; a `422` (claimed / completed / archived) means report it and skip that story. Always amend the existing story id — never author a new story to stand in for one that already exists.
7. Run `/holycode-hub:question-list` again to refresh the local count marker, and report which questions you resolved and which stories you amended or skipped. Make no further Hub calls for this step.
