<!-- holycode-hub:start -->
## Holycode Hub workflow

This repository is linked to a Holycode Hub project — the Hub holds the backlog, estimates and
quality gates; code stays local. The link lives in `.project-management/hub-pointer.md`
(**Project ID** + **Hub URL**); resolve the project from that file.

Work loop (one story at a time), via the `holycode-hub` MCP server:

1. **Claim**: `work_claim { project_id, story_id }` — returns the story, acceptance criteria,
   gate criteria, an 8-hour lease, and rule/command deltas.
2. **Implement locally** — code never leaves this machine.
3. **Verify**: `work_verify { project_id, story_id, evidence }` — the Hub adjudicates the gate.
4. **Complete**: `work_complete { project_id, story_id, commit_sha }` — or `work_release` to
   return the story to the pool.

Project status: `project_status { project_id }`.

Agents with the Holycode Hub plugin (Claude Code) use the slash commands instead:
`/holycode-hub:claim`, `/holycode-hub:verify`, `/holycode-hub:complete`, `/holycode-hub:status`.
<!-- holycode-hub:end -->
