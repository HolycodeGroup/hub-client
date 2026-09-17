# Holycode Hub — Claude Code client (`holycode-hub` plugin)

The lean client layer of the Holycode Hub for Claude Code: seven command stubs, one pointer
file, one session-start convenience check, a rule cache filled by the one-way rule sync, a
version ledger for the project's own rules and the zero-dependency script that applies both. Nothing in this package describes method — every
planning, estimation and gate decision happens on the Hub. The client only knows *which* tool to
call, never *how* the Hub answers.

This is the first adapter of the F-001 family; later adapters (other agents) differ only in
file format.

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
   it; every other stub resolves the project from that file.

Commands are namespaced by the plugin name in Claude Code (`/holycode-hub:init`); the stubs and
messages write the short form `/hub:init`.

## Claiming a story (the rule sync rides every claim)

`/hub:claim <story-id>` calls `work_claim` once and receives the story text, acceptance
criteria, phase context, the project's gate criteria and an 8-hour lease in one response —
plus `directive.rule_deltas`, the one-way framework rule sync (US-018):

1. The stub reads `rules-cache/.manifest.json` (if present) and passes it **verbatim** as
   `rule_cache` — a manifest hash plus `file → sha256` entries, hashes only. The Hub compares
   and returns only what differs: the whole rule tier on the first claim (~430 KB, once per
   machine), nothing when the cache matches, exactly the changed files otherwise.
2. The stub pipes `rule_deltas` into `scripts/apply-rule-deltas.mjs` (Node ≥ 20, no
   dependencies), which writes the files under `rules-cache/` and rewrites `.manifest.json` in
   the request shape for the next claim.
3. A rule you edited locally is **promoted** to `rules-cache/overrides/<name>.local.md` before
   the canon version is written — never overwritten, never sent to the Hub. The Hub accepts no
   rule content in a request (a `body` in `rule_cache` is a 400): the sync is one-way by
   construction.

The cache lives in the plugin directory, never in your repository; a delta whose path would
land outside `rules-cache/` is refused.

## Framework commands (the command tier rides every claim)

Every `/hub:claim` also carries `directive.command_deltas` — the framework command **cards**
(`generate-docs`, `add-scope`, `add-bug`, `run-tests`, `security-scan`, `audit-pm`,
`process-client-docs`, `resolve-questions`, `screen-map`, `estimate-ai-hours`, `execute-work`).
The claim stub pipes them into `scripts/apply-command-deltas.mjs`, which writes them under the
plugin's `commands-cache/` (same one-way delta mechanism as rules; hashes-only `command_cache`).
Cards are the thin command **surface** — they point the agent at the synced framework rules; the
orchestration method never leaves the Hub.

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
| `commands/{init,plan,estimate,export,status,claim,sync,verify,complete,release}.md` | One stub per Hub tool with a real handler — each names exactly one tool and ends with the backstop "Make no further Hub calls for this step." The work loop is `/hub:claim` → (implement locally) → `/hub:verify` → `/hub:complete`, or `/hub:release` to return a story to the pool. |
| `hooks/hooks.json` + `hooks/session-start.sh` | Session-start check: prints the linked project (or how to link one). Reads one local file, never the network, always exits 0 — convenience only; enforcement is the work order minted by the Hub on every call |
| `scripts/apply-rule-deltas.mjs` | Applies `work_claim`'s `rule_deltas`: the framework tier to `rules-cache/` (US-018 — writes changed files, deletes removed ones, promotes local edits to `overrides/`, maintains `.manifest.json`) and the project tier to the repo's `.project-management/rules/` (US-019 — never over an unsynced local edit, maintains `.versions.json`, never deletes); refuses any path outside its directory; never a network call |
| `rules-cache/` | Ships empty (README + `.gitignore`); the one-way rule sync fills it at runtime on the licensee machine — never committed |

Only `work_progress` (the optional heartbeat) has no stub yet — it is a nice-to-have, not
part of the claim → verify → complete loop.

## Never installed

- Method: planning prompts, verification modules, templates, calibration constants
- The Hub's rule-tier sources — only the synced cache under `rules-cache/`, populated at runtime
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
and hook wiring, the session-start script in all three pointer states, and the rule-delta
script against real temp caches and temp project roots (fresh cache, unchanged, local-edit
promotion, removals, traversal refusal, manifest shape, no-network; project tier: ledger shape,
conflict skip, record drop without delete, traversal refusal). The install round trip, the forged-pointer
abuse case and the rule sync over the wire run black-box in `apps/backend/e2e`; the no-method
leak scan runs in `apps/backend/__tests__/integration`.
