#!/usr/bin/env node
// Holycode Hub — apply rule deltas (US-019 PROJECT tier; the US-018 framework
// tier was WITHDRAWN by US-044 — no framework rule file ever lands on a
// developer machine any more, and this script writes no framework cache).
// Node >= 20, ESM, ZERO dependencies.
//
// Usage:  node apply-rule-deltas.mjs [--project-root <dir>] < deltas.json
//   stdin = the `rule_deltas` object from a work_claim result ({ project }),
//   or the whole result (`.directive.rule_deltas` is picked). Default project
//   root: the current working directory (the customer repo). Legacy framework
//   keys (`manifest_sha256`, `changed`, `removed` at the top level — sent by
//   servers/plugins predating US-044) are IGNORED: only the project tier is
//   applied.
//
// PROJECT tier (US-019) — `rule_deltas.project` = { changed: [{ path, version,
// sha256, body }], removed: [path] } lands in the CUSTOMER REPO's
// `.project-management/rules/` under --project-root (these are the project's
// own files — customer property), tracked in
// `.project-management/rules/.versions.json`:
//   { "<path>": { "version": n, "sha256": "<sha256 of the body as written>" } }
// The work_claim `rule_cache` request is that file mapped to
// `{ "project": { "<path>": <version> } }` — versions only, never text or
// hashes (the /holycode-hub:claim stub does exactly that; /holycode-hub:sync sends `version`
// back as `base_version` and records the { version, sha256 } project_sync
// returns).
//
// Invariants (tested in __tests__/apply-rule-deltas.test.ts):
//   - a project delta path must be `.project-management/rules/<flat name>.md` (or a repository's
//     own `stack-adapter.<name>.md`, HH-480)
//     AND resolve inside that directory under the project root, and its sha256
//     must be the sha256 of its body — else REFUSED (nothing written);
//   - a project file whose CURRENT sha256 is neither the recorded one nor the
//     incoming one is an UNSYNCED LOCAL EDIT: it is NEVER overwritten — skipped,
//     listed under `project.conflicts`, exit 1 — the user runs /holycode-hub:sync first;
//   - a `project.removed` path only DROPS the `.versions.json` record — a
//     customer file is never deleted by this script (v1 has no delete);
//   - NEVER a network call; prints one JSON line
//     { project: { written, dropped, refused, conflicts: [path] } }.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// A flat name, or a repository's own stack adapter `stack-adapter.<name>.md` (HH-480).
const RULE_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9-]*|stack-adapter\.[a-z0-9][a-z0-9-]{0,62})\.md$/;
/** The project tier's home inside the customer repo (US-019). */
const PROJECT_RULES_DIR = '.project-management/rules/';
const VERSIONS_FILE = '.versions.json';

function flagValue(argv, name) {
  const flag = argv.indexOf(name);
  return flag !== -1 && argv[flag + 1] ? path.resolve(argv[flag + 1]) : null;
}

function projectRootFrom(argv, cwd) {
  return flagValue(argv, '--project-root') ?? path.resolve(cwd);
}

/**
 * Picks the project tier off stdin. Accepts the whole work_claim result, a
 * rule_deltas object ({ project }), or the LEGACY pre-US-044 shape (framework
 * `changed`/`removed` at the top level — ignored, applied as an empty tier).
 * Anything else is malformed (exit non-zero, nothing written).
 */
function readProjectDeltas(stdin) {
  const parsed = JSON.parse(stdin);
  const deltas = parsed?.directive?.rule_deltas ?? parsed?.rule_deltas ?? parsed;
  const project = deltas?.project;
  if (Array.isArray(project?.changed) && Array.isArray(project?.removed)) return project;
  // Legacy framework-only shape (pre-US-044 server): nothing to apply.
  if (Array.isArray(deltas?.changed) && Array.isArray(deltas?.removed)) {
    return { changed: [], removed: [] };
  }
  throw new Error('stdin is not a rule_deltas object ({ project: { changed, removed } })');
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function readVersions(rulesDir) {
  const file = path.join(rulesDir, VERSIONS_FILE);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
}

function writeVersions(rulesDir, versions) {
  const sorted = Object.fromEntries(Object.entries(versions).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(path.join(rulesDir, VERSIONS_FILE), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

/** Absolute target for a project delta path, or null when it must be refused. */
function resolveProjectRule(rulesDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.startsWith(PROJECT_RULES_DIR)) return null;
  const name = relPath.slice(PROJECT_RULES_DIR.length);
  if (!RULE_PATH.test(name)) return null;
  const target = path.resolve(rulesDir, name);
  return target.startsWith(rulesDir + path.sep) && path.dirname(target) === rulesDir
    ? target
    : null;
}

/**
 * Applies `rule_deltas.project` under `<projectRoot>/.project-management/rules/`
 * (module header). Never overwrites an unsynced local edit; never deletes.
 */
export function applyProjectDeltas(project, projectRoot) {
  const rulesDir = path.resolve(projectRoot, PROJECT_RULES_DIR);
  mkdirSync(rulesDir, { recursive: true });
  const versions = readVersions(rulesDir);
  const summary = { written: 0, dropped: 0, refused: 0, conflicts: [] };
  let mutated = false;

  for (const entry of project.changed) {
    const target = resolveProjectRule(rulesDir, entry?.path);
    const validBody = typeof entry?.body === 'string' && sha256(entry.body) === entry?.sha256;
    if (target === null || !validBody || !Number.isInteger(entry.version)) {
      summary.refused += 1;
      continue;
    }
    if (existsSync(target)) {
      const current = sha256(readFileSync(target, 'utf8'));
      const recorded = versions[entry.path]?.sha256;
      if (current !== recorded && current !== entry.sha256) {
        summary.conflicts.push(entry.path); // unsynced local edit — never overwritten
        continue;
      }
    }
    writeFileSync(target, entry.body, 'utf8');
    versions[entry.path] = { version: entry.version, sha256: entry.sha256 };
    summary.written += 1;
    mutated = true;
  }

  for (const relPath of project.removed) {
    if (resolveProjectRule(rulesDir, relPath) === null) {
      summary.refused += 1;
      continue;
    }
    if (relPath in versions) {
      delete versions[relPath]; // the record only — the customer's file stays
      summary.dropped += 1;
      mutated = true;
    }
  }

  if (mutated) writeVersions(rulesDir, versions);
  return summary;
}

/** The one-line JSON summary main() prints: the project tier only (US-044). */
export function applyRuleDeltas(project, projectRoot = process.cwd()) {
  return { project: applyProjectDeltas(project, projectRoot) };
}

/** Exit 1 when anything was refused or a project file was skipped as an unsynced edit. */
function exitCodeFor(summary) {
  return summary.project.refused > 0 || summary.project.conflicts.length > 0 ? 1 : 0;
}

/**
 * Reads ALL of stdin synchronously — robust on a non-blocking PIPE.
 *
 * `readFileSync(0)` throws `EAGAIN` once the piped payload exceeds the OS pipe
 * buffer (~64 KB): a work_claim result carrying several project rules can clear
 * that, so this drains fd 0 in a `readSync` loop instead, retrying on EAGAIN
 * (data not yet available) and stopping at EOF (0 bytes read).
 * Zero-dependency, synchronous — keeps `main()` unchanged in shape.
 */
function readStdinSync() {
  const chunkSize = 65_536;
  const buffer = Buffer.alloc(chunkSize);
  const chunks = [];
  for (;;) {
    let bytesRead;
    try {
      bytesRead = readSync(0, buffer, 0, chunkSize, null);
    } catch (err) {
      // EAGAIN: the pipe has no data ready yet — retry. Any other error is fatal.
      if (err.code === 'EAGAIN') continue;
      if (err.code === 'EOF') break;
      throw err;
    }
    if (bytesRead === 0) break; // EOF
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function main() {
  const argv = process.argv.slice(2);
  const summary = applyRuleDeltas(
    readProjectDeltas(readStdinSync()),
    projectRootFrom(argv, process.cwd()),
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = exitCodeFor(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
