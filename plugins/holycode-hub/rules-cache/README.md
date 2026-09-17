# Rule Cache

Populated at runtime, never committed. `/hub:claim` calls `work_claim` with the hashes in
`.manifest.json` and pipes the returned `rule_deltas` into `scripts/apply-rule-deltas.mjs`,
which writes the framework rule files here — plain rule files only, never modules, templates,
prompts or calibration constants (hard rule: nothing that describes method ships in the client
layer). The sync is one-way (Hub → here) and rides every claim, not session start.

What lands here:

- `<name>.md` — the framework rule files as the Hub publishes them (the licensed rule tier).
- `.manifest.json` — `{ "manifest_sha256", "files": { "<name>.md": "<sha256>" } }`, exactly the
  `rule_cache` shape the next `work_claim` sends. Hashes only; it never carries rule content.
- `overrides/` — your local edits, promoted out of the way (see below).

**Do not hand-edit files here** — edits are promoted to `overrides/<name>.local.md` on the next
sync (never overwritten, never sent to the Hub) and the canon version is written in their place.
A delta whose path is not a flat `name.md` inside this directory is refused and nothing is written.

The repository ships this directory empty (this README and `.gitignore` only); the backend leak
scan asserts it.

The project's OWN rule files never land here: `rule_deltas.project` (US-019) is written into the
customer repository's `.project-management/rules/` (tracked by `.versions.json` there) — they are
project property and flow both ways through `/hub:sync`.
