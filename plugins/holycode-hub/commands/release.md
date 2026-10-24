---
description: Release a claimed Hub story's lease without completing it — return the story to the pool for another developer
argument-hint: <story-key>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. First run `node "${CLAUDE_PLUGIN_ROOT}/scripts/effort-capture.mjs" take` — it prints the effort measured since the last report as a JSON array (timestamps, actor and category only; never prompt text or code). When the array is non-empty, add it to the call as `"segments": <that array>` and do NOT send `human_ms` / `ai_ms`; when it prints `[]` or the command fails, use the estimate instead. Otherwise estimate the human-vs-AI time split for the work so far (your best estimate in milliseconds — `human_ms` for the human thinking/deciding/reviewing, `ai_ms` for your generating; together ~the elapsed time), then call the `work_release` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "story_id": "$ARGUMENTS", "human_ms": <human estimate>, "ai_ms": <AI estimate> }` — it is an ESTIMATE, not a measurement; OMIT both fields if you genuinely cannot estimate (never send `0` / `0`).
4. Handle the answer:
   - success → tell the user the lease is released and the story is claimable again by any developer.
   - `FORBIDDEN_CLAIM` → tell the user they do not hold this story's lease (nothing to release — it was never claimed by them, or already released/expired) and stop.
   - any other error → report the code + request id and stop; never work around it.
5. Make no further Hub calls for this step.
