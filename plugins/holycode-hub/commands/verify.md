---
description: Submit a claimed Hub story's gate evidence and receive the Hub's verdict — run the local gate, assemble the evidence, call work_verify
argument-hint: <story-id>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Run the local gate (tests, coverage, lint, dependency audit) and the diff, then assemble the `evidence` object EXACTLY per the `work_verify` tool's input schema — `tests`, `coverage`, `lint`, `audit`, `diff`, `ac_table`, `status_matrix`, `attested` — from those real results. The Hub judges this evidence; it never runs your tests. Never fabricate a value to pass.
4. Call the `work_verify` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "story_id": "$ARGUMENTS", "evidence": <that object> }`.
5. On `VALIDATION_TOOL_INPUT` fix the evidence field named in the error and re-run; on `FORBIDDEN_CLAIM` tell the user to claim the story first (/hub:claim) and stop.
6. On a `result` report `verified.passed` and each `verified.checks` entry (name, passed, detail), the echoed `attested` claims and any `remediation`; if it did not pass, address the remediation and re-run (a fresh `attempt`), else the story is ready for /hub:complete.
7. Make no further Hub calls for this step.
