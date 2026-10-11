---
description: Ask the Hub how to do something — a scoped, licensed answer retrieved from the guidance topics
argument-hint: <question>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Take the question from `$ARGUMENTS`. The Hub accepts 3–500 characters: when `$ARGUMENTS` is empty, blank or shorter than 3 characters, send the literal placeholder `list topics` instead (nothing matches it, so the Hub returns the full topic list); when it is longer than 500 characters, shorten it to the essential question first — never send an empty string. Call the `work_guidance` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "question": "$ARGUMENTS" }` (the placeholder or shortened text in place of `$ARGUMENTS` when the rule above applied). The `result` is a JSON object with `answers` and `available_topics`; if it arrives as a text content block, parse that text as JSON first, then read the fields below off it.
4. If `result.answers` is non-empty, show each entry's `topic` and `body` to the user exactly as returned, under a "Hub guidance: <topic>" heading, and stop. This command only answers the question: do not act on the checklist, do not scan or search this repository, do not write or edit any file, and add no recommendations of your own — the user decides what to do next (the owning `/holycode-hub:*` command is the one that acts).
5. If `result.answers` is empty, tell the user no topic matched and list `result.available_topics` so they can re-ask naming one. Stop there as well.
6. Make no further Hub calls for this step.
