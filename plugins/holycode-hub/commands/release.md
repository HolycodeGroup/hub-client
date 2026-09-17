---
description: Release a claimed Hub story's lease without completing it — return the story to the pool for another developer
argument-hint: <story-id>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Call the `work_release` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "story_id": "$ARGUMENTS" }`.
4. Handle the answer:
   - success → tell the user the lease is released and the story is claimable again by any developer.
   - `FORBIDDEN_CLAIM` → tell the user they do not hold this story's lease (nothing to release — it was never claimed by them, or already released/expired) and stop.
   - any other error → report the code + request id and stop; never work around it.
5. Make no further Hub calls for this step.
