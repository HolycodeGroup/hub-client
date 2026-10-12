---
description: Mark a claimed Hub story complete — anchor its commit, release the lease, record the completion
argument-hint: <story-key> [commit-sha]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. The first `$ARGUMENTS` token is the story key (e.g. `DHWH-7`; an old story id also works); the optional second is the commit sha — when absent, take the current commit from `git rev-parse HEAD`, and if that fails tell the user "Pass the commit sha: /holycode-hub:complete <story-id> <commit-sha>" and stop.
4. Call the `work_complete` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "story_id": "<story id>", "commit_sha": "<that sha>" }`.
5. On success report the recorded commit, the completion time, and that the lease is released and the story is now `Completed`. Then ALWAYS end with what comes next, exactly as the Hub returned it in `result.next`: when `result.next.ready` is non-empty, write `Next: <key> — <title>` for its first entry and `Run /holycode-hub:claim <key>` (or `/holycode-hub:claim` with no argument), listing any other ready entries below it; when it is empty and `result.next.waiting` is not, say nothing is ready yet and list each waiting story's key with the keys and statuses in its `blocked_by`; when both are empty, say the backlog has no TODO story left. Never pick or suggest a story yourself.
6. On `CONFLICT_ALREADY_COMPLETED` tell the user the story is already complete (never retry); on `FORBIDDEN_CLAIM` tell them they do not hold this story's lease (claim it first); on any other error report the code + request id and stop.
7. Make no further Hub calls for this step.
