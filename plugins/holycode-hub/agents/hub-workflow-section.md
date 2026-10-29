<!-- holycode-hub:start -->
<!-- holycode-hub:block-version: 3 -->
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

**Outdated plugin:** when any Hub result carries `client_outdated`, tell the developer the plugin
is outdated — installed `client_outdated.installed`, published `client_outdated.published` — and to
run `/holycode-hub:update`, then restart Claude Code. Give no other update steps.

### Git conventions (apply from the very first commit)

The Hub delivers full rules per claim, but the pointer + `AGENTS.md` commit happens before
any claim — so these always-on conventions apply immediately:

- **Conventional commit** subjects (`feat:`, `fix:`, `docs:`, `chore:` …), imperative, ≤ 72 chars.
- **NO AI credits** — never add `Co-Authored-By: <AI>` or "Generated with …" trailers.
- **Branch + pull request** — create a `<type>/<descriptor>` branch and open a PR.
  **Never commit directly to `main`** (it is protected). The link commit (pointer + `AGENTS.md`)
  follows this too.
<!-- holycode-hub:end -->
