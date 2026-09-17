---
description: Mark a claimed Hub story complete — anchor its commit, release the lease, record the completion
argument-hint: <story-id> [commit-sha]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. The first `$ARGUMENTS` token is the story id; the optional second is the commit sha — when absent, take the current commit from `git rev-parse HEAD`, and if that fails tell the user "Pass the commit sha: /hub:complete <story-id> <commit-sha>" and stop.
4. Call the `work_complete` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "story_id": "<story id>", "commit_sha": "<that sha>" }`.
5. On success report the recorded commit, the completion time, and that the lease is released and the story is now `Completed`.
6. On `CONFLICT_ALREADY_COMPLETED` tell the user the story is already complete (never retry); on `FORBIDDEN_CLAIM` tell them they do not hold this story's lease (claim it first); on any other error report the code + request id and stop.
7. Make no further Hub calls for this step.
