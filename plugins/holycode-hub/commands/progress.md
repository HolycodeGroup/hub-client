---
description: Report the effort measured on a claimed Hub story so far — human and AI time per step, timestamps only
argument-hint: <story-key>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/effort-capture.mjs" take` — it prints the effort measured since the last report as a JSON array (timestamps, actor and category only; never prompt text or code). When it prints `[]` or fails, tell the user there is nothing new to report and stop.
4. Call the `work_progress` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "story_id": "$ARGUMENTS", "segments": <that array> }`.
5. On success tell the user how many segments were reported; on `FORBIDDEN_CLAIM` tell them they do not hold this story's lease; on `VALIDATION_EFFORT_SEGMENT` report the Hub's message (it names the segment); on any other error report the code + request id. Make no further Hub calls for this step.
