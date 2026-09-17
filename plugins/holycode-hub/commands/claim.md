---
description: Claim a Hub story for implementation — story text, acceptance criteria, phase context, directive, synced framework rules, project rules and command cards, and an 8-hour lease in one call
argument-hint: <story-id>
---
1. Read `.project-management/hub-pointer.md` and take the value of its `**Project ID:**` line.
2. If the file is missing or has no project id, tell the user "No Hub project in this directory — run /hub:init" and stop.
3. Build `rule_cache`: if `${CLAUDE_PLUGIN_ROOT}/rules-cache/.manifest.json` exists, take its parsed contents verbatim; if `.project-management/rules/.versions.json` exists, add `"project": { "<path>": <that entry's version> }` (versions only — never text or hashes); omit `rule_cache` entirely when neither file exists. Build `command_cache`: if `${CLAUDE_PLUGIN_ROOT}/commands-cache/.manifest.json` exists, take its parsed contents verbatim, else omit it.
4. Call the `work_claim` tool on the `holycode-hub` MCP server exactly once with `{ "project_id": "<that id>", "story_id": "$ARGUMENTS", "rule_cache": <that object, when present>, "command_cache": <that object, when present> }`.
5. Pipe the JSON of `result.directive.rule_deltas` into `node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-rule-deltas.mjs" --project-root "$PWD"` (stdin) and report its one-line summary; a non-zero exit means a delta was refused or a project file was skipped as an unsynced local edit (`project.conflicts`) — report it and suggest `/hub:sync`, never work around it.
6. Pipe the JSON of `result.directive.command_deltas` into `node "${CLAUDE_PLUGIN_ROOT}/scripts/apply-command-deltas.mjs"` (stdin) and report its one-line summary; a non-zero exit means a card was refused — report it, never work around it.
7. Tell the user the lease expiry (`result.lease.expires_at`), that the story text, acceptance criteria, phase context and gate criteria are in the response, that the framework rules now live in the plugin's `rules-cache/`, the project's own rule deltas in this repository's `.project-management/rules/`, and the framework command cards in the plugin's `commands-cache/`. Make no further Hub calls for this step.
