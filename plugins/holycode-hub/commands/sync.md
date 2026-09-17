---
description: Publish this project's own rule files (.project-management/rules/*.md) to the Hub with version checks so every teammate shares one canon
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Read `.project-management/rules/.versions.json` (a missing file is `{}`); for each of the allowed files `project-rules.md`, `stack-adapter.md`, `TESTING-RULES.md`, `I18N-RULES.md`, `QA-PIPELINE.md`, `JIRA-INTEGRATION.md` that exists under `.project-management/rules/` and whose sha256 differs from its recorded `sha256` (or has no record), build `{ "path": ".project-management/rules/<name>", "base_version": <the recorded version, or null when unrecorded>, "body": <the file's full text> }`.
4. If nothing changed, tell the user the project rules are in sync and stop; otherwise call the `project_sync` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "rules": [<those entries>] }`.
5. On success, set `.versions.json[path] = { "version": version, "sha256": sha256 }` for every returned `{ path, version, sha256 }`, write the file back, and report the new versions.
6. On a 409 (`CONFLICT_STALE_VERSION`) tell the user which file is stale — the message names it and its current version — and to run `/hub:claim` first (it delivers the current version into `.project-management/rules/`) before editing again; change nothing locally.
7. Make no further Hub calls for this step.
