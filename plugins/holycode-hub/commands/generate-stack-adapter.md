---
description: Generate this project's stack-adapter overlay — map the default-stack rule examples to this project's actual stack, following the Hub's overlay-shape guidance
argument-hint: 
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Call the `work_guidance` tool on the `holycode-hub` MCP server with `{ "project_id": "<that id>", "question": "stack-adapter" }` and take the overlay shape from the returned answer.
4. Do what the returned checklist says, in this repository only: if the project already runs the default stack, report that no adapter is needed and stop; if an adapter already exists, confirm before overwriting. Otherwise write `.project-management/rules/stack-adapter.md` to the returned shape, then publish it with `/holycode-hub:sync` so the team shares one translation.
5. Report the file written (or that the default stack needs no adapter). Make no further Hub calls for this step.
