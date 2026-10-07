---
description: Scan this project and generate scripts that boot the whole dev environment (start/stop/status), following the Hub's dev-environment guidance
argument-hint: [--force] [--dry-run]
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /holycode-hub:init" and stop.
3. Call the `work_guidance` tool on the `holycode-hub` MCP server with `{ "project_id": "<that id>", "question": "dev-environment" }` and take the tooling shape from the returned answer (the detection matrix, the three scripts, the conditional blocks, the confirm-before-write discipline).
4. Scan this project read-only — stack and project type, container-compose services, app processes (backend / web / mobile), and each infra service (database, mail catcher, object storage, cache, queues) with its evidence — and show the detection report as a table; confirm it before writing. With `--dry-run`, stop after the report and write nothing. Otherwise generate `scripts/dev/start-env.sh` / `stop-env.sh` / `env-status.sh` + the matching package scripts, adding only the blocks the detection justified (a database wait-and-migrate step only when a database was found, a mobile branch only for a detected mobile app); never overwrite a file lacking the generated marker without `--force` or a per-file confirmation.
5. Report the files written (or the detection report for a dry run). These are local scripts in your repository. Make no further Hub calls for this step.
