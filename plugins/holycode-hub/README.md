# Holycode Hub — Claude Code client (`holycode-hub` plugin)

The lean client layer of the Holycode Hub for Claude Code: the command stubs, one pointer
file, one session-start convenience check, a command-card cache filled by the one-way command
sync, a version ledger for the project's own rules and the zero-dependency scripts that apply
both. Nothing in this package describes method, and **no framework rule file ever lands on
this machine** (US-044) — every planning, estimation and gate decision happens on the Hub,
and the knowledge a step needs arrives in the claim directive. The client only knows *which*
tool to call, never *how* the Hub answers.

This is the first adapter of the F-001 family; later adapters (other agents) differ only in
file format.

## Architecture — source of truth is `hub-client-core` (F-001)

This package does not author the sync engine or the command surface — it **commits copies** of
them from [`packages/hub-client-core`](../hub-client-core/README.md), the tool-neutral source of
truth:

- `scripts/apply-rule-deltas.mjs` + `scripts/apply-command-deltas.mjs` are **byte-identical copies**
  of the core scripts (so the shipped plugin stays self-contained and `claude --plugin-dir` works).
- `commands/*.md` are **generated** from the core command spec (`hub-client-core/src/command-spec.mjs`)
  by its Claude renderer — the frontmatter carries no `name:`, so each registers as
  `/holycode-hub:<name>` (never a bare `/name`).

After editing a core apply script or the command spec, regenerate the committed copies:

```bash
node scripts/sync-client-from-core.mjs   # from the repo root
```

Two drift tests fail until you regenerate and commit: `core-copy-sync.test.ts` (scripts) and
`stub-generation.test.ts` (stubs). The regeneration is **manual by design** — never a build step —
so CI's pre-test build can never mask a stale committed copy. See
[`hub-client-core/README.md`](../hub-client-core/README.md) → "How to add a new tool adapter".

## Install (three steps, no repository clone)

1. **Install the plugin.** The package directory is a complete Claude Code plugin
   (`.claude-plugin/plugin.json`). Installing it also registers the Hub MCP server — the
   bundled `.mcp.json` declares `holycode-hub` at `https://hub.holycode.com/mcp`, so there is
   no server URL to type. For local development: `claude --plugin-dir ./packages/client-claude-code`.
2. **Sign in once.** On the first Hub call Claude Code runs its native OAuth flow for HTTP MCP
   servers (the Hub serves discovery, dynamic client registration and PKCE). The credential
   lands in Claude Code's own store — never in this repository.
3. **Link the directory:** run `/hub:init` in the project you want to connect.
   - An **OWNER** creates a new Hub project (one `project_create` call).
   - A **DEVELOPER** joins an existing one with the id the owner shares: `/hub:init <project-id>`
     (zero Hub calls).

   Both write `.project-management/hub-pointer.md` — the project id plus the Hub URL. Commit
   it; every other stub resolves the project from that file. The same step also seeds the
   repository's `AGENTS.md` with the Hub workflow section (F-008) — a marker-bounded block
   copied from the shipped `agents/hub-workflow-section.md`, so ANY agent reading `AGENTS.md`
   (Codex, Cursor, Gemini — no plugin needed) learns the claim → verify → complete loop. Re-runs
   replace only the block between the markers; your own `AGENTS.md` content is never touched.

   `/hub:init` then also points you at `/hub:sync-commands` (+ a Claude Code restart) so the same
   onboarding step pulls the framework commands (`/holycode-hub:execute-work`, `/holycode-hub:add-bug`, …)
   — one command step to become productive, not two.

Commands are namespaced by the plugin name in Claude Code (`/holycode-hub:init`); the stubs and
messages write the short form `/hub:init`.

## Claiming a story (the directive is the knowledge)

`/hub:claim <story-id>` calls `work_claim` once and receives the story text, acceptance
criteria, phase context, the project's gate criteria and an 8-hour lease in one response.
**The framework rule sync (US-018) is withdrawn (US-044):** no framework rule file is ever
written to this machine — `directive.rule_deltas` carries only the `project` tier (your own
project's rule files), and the Hub's rule canon is egress-guarded server-side. What a step
needs to know arrives in the directive itself. The Hub still accepts no rule content in a
request (a `body` in `rule_cache` is a 400), and a legacy 0.2.x client that still sends its
old framework hashes is accepted-and-ignored rather than broken.

## Framework commands (the command tier rides every claim)

Every `/hub:claim` also carries `directive.command_deltas` — the framework command **cards**
(`generate-docs`, `add-scope`, `add-bug`, `run-tests`, `security-scan`, `audit-pm`,
`process-client-docs`, `resolve-questions`, `screen-map`, `estimate-ai-hours`, `execute-work`).
The claim stub pipes them into `scripts/apply-command-deltas.mjs`, which writes them under the
plugin's `commands-cache/` (a one-way hash-delta mechanism; hashes-only `command_cache`).
Cards are the thin command **surface** — they point the agent at the directive each claim
returns; the orchestration method (and the framework rule canon) never leaves the Hub.

The plugin manifest lists **both** command directories — `"commands": ["./commands/",
"./commands-cache/"]` — so the synced cards register as slash commands alongside the shipped
`/hub:*` stubs. **Important — Claude Code discovers commands at session load, not mid-session:**
after your first `/hub:claim`, the framework commands appear in the next `claude` session (type
`/` to list them, or `/plugin list`). They will not appear in the same session the claim ran in.

## Project rules — two-way (US-019)

The project's OWN rule files — `.project-management/rules/{project-rules,stack-adapter,
TESTING-RULES,I18N-RULES,QA-PIPELINE,JIRA-INTEGRATION}.md` — are project property and flow
both ways, tracked by `.project-management/rules/.versions.json`
(`{ "<path>": { "version": n, "sha256": "…" } }`, committed with the repo):

- **Write — `/hub:sync`:** every allowed file whose sha256 differs from its recorded one is sent
  through `project_sync` with its recorded version as `base_version` (`null` when the file is
  new on the Hub). The Hub stores it as `base_version + 1`; a file a teammate changed underneath
  is refused with a 409 naming the current version — the stub tells you which file and to
  `/hub:claim` first (that delivers the current version), never overwriting anything locally.
- **Read — rides `/hub:claim`:** the stub adds `rule_cache.project` (`path → version` from the
  ledger) to the claim; `rule_deltas.project` comes back with every file you lack or hold at a
  different version, and `apply-rule-deltas.mjs --project-root "$PWD"` writes them into
  `.project-management/rules/` and updates the ledger. A file you edited locally but have not
  synced is **never overwritten**: it is skipped and listed under `project.conflicts` (exit 1) —
  run `/hub:sync` first. A `removed` path only drops its ledger record; the script never deletes a
  customer file.
- `project_export` includes the latest version of every project rule (customer property).

## What ships

| Path | Purpose |
|------|---------|
| `.claude-plugin/plugin.json` | Plugin manifest (`holycode-hub`) |
| `.mcp.json` | The Hub MCP server entry (install step 1) |
| `commands/{init,plan,estimate,export,status,claim,sync,sync-commands,guidance,verify,complete,release}.md` | One stub per Hub tool with a real handler — 12 commands, each names exactly one tool and ends with the backstop "Make no further Hub calls for this step." The work loop is `/hub:claim` → (implement locally) → `/hub:verify` → `/hub:complete`, or `/hub:release` to return a story to the pool. `/hub:sync-commands` downloads the framework command cards without claiming a story; `/hub:guidance <question>` asks the Hub a how-to question and receives a scoped, licence-gated answer (never a rule file). |
| `hooks/hooks.json` + `hooks/session-start.sh` | Session-start check: prints the linked project (or how to link one). Reads one local file, never the network, always exits 0 — convenience only; enforcement is the work order minted by the Hub on every call |
| `agents/hub-workflow-section.md` | The marker-bounded `AGENTS.md` workflow block `/hub:init` seeds into the customer repo (F-008) — cross-tool onboarding so MCP-only agents learn the work loop; committed copy of the `hub-client-core` source |
| `scripts/apply-rule-deltas.mjs` | Applies `work_claim`'s `rule_deltas` — the PROJECT tier only (US-019; the framework tier is withdrawn, US-044) — to the repo's `.project-management/rules/` (never over an unsynced local edit, maintains `.versions.json`, never deletes); refuses any path outside that directory; never a network call |

Only `work_progress` (the optional heartbeat) has no stub yet — it is a nice-to-have, not
part of the claim → verify → complete loop.

## Never installed

- Method: planning prompts, verification modules, templates, calibration constants
- **Any framework rule file** — the rule tier stays on the Hub (US-044); the knowledge a step
  needs arrives in the claim directive, and the project's own rules live in your repository
- Any credential — sign-in lives in Claude Code's credential store

The whole package is scanned in the backend test suite against the egress guard's own
protected-content registry: what the Hub refuses to send, the client must not ship either.

## Pointing at another Hub

The bundled entry targets production. For localhost or staging, register the server yourself
under the same name in the project (for example
`claude mcp add --transport http holycode-hub http://localhost:3000/mcp`) and confirm with
`/mcp` that the intended URL is the one in use. The pointer file's `**Hub URL:**` line is
informational — the connected server decides where calls go.

## Tests

`pnpm --filter client-claude-code test` — stub budget and backstop, one-tool-per-stub, manifest
and hook wiring, the session-start script in all three pointer states, and (in
`hub-client-core`) the rule-delta script against real temp project roots (project tier only:
ledger shape, conflict skip, record drop without delete, traversal refusal, legacy
framework-payload no-op, no-network). The install round trip, the forged-pointer abuse case
and the rule-sync withdrawal over the wire run black-box in `apps/backend/e2e`; the no-method
+ no-canon leak scans run in `apps/backend/__tests__/integration`.
