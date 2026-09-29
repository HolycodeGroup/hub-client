---
description: Ask the Hub how to do something — a scoped, licensed answer retrieved from the guidance topics
argument-hint: <question>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Call the `work_guidance` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "question": "$ARGUMENTS" }`. The `result` is a JSON object with `answers` and `available_topics`; if it arrives as a text content block, parse that text as JSON first, then read the fields below off it.
4. If `result.answers` is non-empty, present each entry's `topic` and `body` to the user and follow that guidance for the step.
5. If `result.answers` is empty, tell the user no topic matched and list `result.available_topics` so they can re-ask naming one.
6. Make no further Hub calls for this step.
