# Command-Card Cache

Populated at runtime, never committed. `/hub:claim` calls `work_claim` with the hashes in
`.manifest.json` and pipes the returned `command_deltas` into `scripts/apply-command-deltas.mjs`,
which writes the framework command **cards** here — thin `/hub:*` command surface only, never the
orchestration method (hard rule: nothing that describes method ships in the client layer). The
sync is one-way (Hub → here) and rides every claim, not session start.

What lands here:

- `<name>.md` — the framework command cards as the Hub publishes them (the licensed command tier).
  Each card is a thin command that points the agent at the synced framework rules in `rules-cache/`;
  it carries no orchestration steps.
- `.manifest.json` — `{ "manifest_sha256", "files": { "<name>.md": "<sha256>" } }`, exactly the
  `command_cache` shape the next `work_claim` sends. Hashes only; it never carries card content.
- `overrides/` — your local edits, promoted out of the way (see below).

**Do not hand-edit files here** — edits are promoted to `overrides/<name>.local.md` on the next
sync (never overwritten) and the canon version is written in their place. A delta whose path is not
a flat `name.md` inside this directory is refused and nothing is written.

The repository ships this directory empty (this README and `.gitignore` only); the backend leak
scan asserts it.
