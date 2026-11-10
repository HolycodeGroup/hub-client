<!-- holycode-hub:start -->
<!-- holycode-hub:block-version: 5 -->
## Holycode Hub workflow

This repository is linked to a Holycode Hub project — the Hub holds the backlog, estimates and
quality gates; code stays local. The link lives in `.project-management/hub-pointer.md`
(**Project ID** + **Hub URL**); resolve the project from that file.

Work loop (one story at a time), via the `holycode-hub` MCP server:

1. **Claim**: `work_claim { project_id, story_id }` — returns the story, acceptance criteria,
   gate criteria, an 8-hour lease, and rule/command deltas.
2. **Read the project rules** — every Markdown file in `.project-management/rules/` (the claim's
   `directive.project_rules` lists the ones the Hub holds). Apply them while implementing and
   verifying; on a conflict the project rules win over Hub guidance.
3. **Implement locally** — code never leaves this machine.
4. **Verify**: `work_verify { project_id, story_id, evidence }` — the Hub adjudicates the gate.
5. **Complete**: `work_complete { project_id, story_id, commit_sha }` — or `work_release` to
   return the story to the pool.

Project status: `project_status { project_id }`.

Agents with the Holycode Hub plugin (Claude Code) use the slash commands instead:
`/holycode-hub:claim`, `/holycode-hub:verify`, `/holycode-hub:complete`, `/holycode-hub:status`.

**Outdated plugin:** when any Hub result carries `client_outdated`, tell the developer the plugin
is outdated — installed `client_outdated.installed`, published `client_outdated.published` — and to
run `/holycode-hub:update`, then restart Claude Code. Give no other update steps.

### Code review findings

Projects with Holycode Code Review can turn findings into tickets and back. Read findings with
`project_code_review_findings` (it returns the ticket instructions too); draft tickets by those
instructions and confirm them with the developer before `project_code_review_tickets_add`. A claimed
code-review story names its finding (`story.code_review`): read the code at that location, then either
fix it (verify, complete) or, when it is not a real problem, close it with `work_close` and an honest
resolution and reason — never close a story just to clear the backlog. Claude Code users also have
`/holycode-hub:code-review-tickets` and `/holycode-hub:close`.

### Git conventions (apply from the very first commit)

A claim delivers the story, the Hub's guidance checklists, the project's own rules and the
command cards; the framework's own rules never leave the Hub. The pointer + `AGENTS.md` commit
happens before any claim — so these always-on conventions apply immediately:

- **Conventional commit** subjects (`feat:`, `fix:`, `docs:`, `chore:` …), imperative, ≤ 72 chars.
- **NO AI credits** — never add `Co-Authored-By: <AI>` or "Generated with …" trailers.
- **Branch + pull request** — create a `<type>/<descriptor>` branch and open a PR.
  **Never commit directly to `main`** (it is protected). The link commit (pointer + `AGENTS.md`)
  follows this too.
<!-- holycode-hub:end -->
