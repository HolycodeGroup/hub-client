---
description: Scan this project and generate scripts that boot the whole dev environment (start/stop/status), following the Hub's dev-environment guidance
argument-hint: [--force] [--dry-run]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Call the `work_guidance` tool on the `holycode-hub` MCP server with `{ "project_id": "<that id>", "question": "dev-environment" }` and take the tooling shape from the returned answer.
4. Do what the returned checklist says, in this repository only: scan read-only and show the detection report as a table; confirm it before writing (with `--dry-run`, stop after the report and write nothing). Then generate `scripts/dev/start-env.sh` / `stop-env.sh` / `env-status.sh` and the matching package scripts. Never overwrite a file lacking the generated marker without `--force` or a per-file confirmation.
5. Report the files written (or the detection report for a dry run). These are local scripts in your repository. Make no further Hub calls for this step.
