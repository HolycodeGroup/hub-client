#!/usr/bin/env node
// Holycode Hub — apply rule deltas (US-018 framework tier, US-019 project tier).
// Node >= 20, ESM, ZERO dependencies.
//
// Usage:  node apply-rule-deltas.mjs [--cache <dir>] [--project-root <dir>] < deltas.json
//   stdin = the `rule_deltas` object from a work_claim result, or the whole
//   result (`.directive.rule_deltas` is picked). Default cache dir:
//   ${CLAUDE_PLUGIN_ROOT}/rules-cache, else ../rules-cache next to this script.
//   Default project root: the current working directory (the customer repo).
//
// FRAMEWORK tier (US-018) — owns `rules-cache/.manifest.json`, written in
// EXACTLY the work_claim `rule_cache` request shape — { manifest_sha256,
// files: { path: sha256 } }, hashes only — so the /hub:claim stub passes it
// through verbatim next time.
//
// PROJECT tier (US-019) — `rule_deltas.project` = { changed: [{ path, version,
// sha256, body }], removed: [path] } lands in the CUSTOMER REPO's
// `.project-management/rules/` under --project-root (these are the project's
// own files, the reverse direction of the plugin cache), tracked in
// `.project-management/rules/.versions.json`:
//   { "<path>": { "version": n, "sha256": "<sha256 of the body as written>" } }
// The work_claim `rule_cache.project` map is that file mapped to path → version:
//   Object.fromEntries(Object.entries(versions).map(([p, v]) => [p, v.version]))
// (the /hub:claim stub does exactly that; /hub:sync sends `version` back as
// `base_version` and records the { version, sha256 } project_sync returns).
//
// Invariants (tested in __tests__/apply-rule-deltas.test.ts):
//   - a framework delta path must match the flat canon shape AND resolve inside
//     the cache root, else it is REFUSED (counted, exit 1, nothing written);
//   - a cached framework file whose CURRENT sha256 differs from the last
//     delivered one is a LOCAL EDIT: moved to overrides/<name>.local.md (-2,
//     -3, ... never overwriting) BEFORE the canon body lands or the file is removed;
//   - a project delta path must be `.project-management/rules/<flat name>.md`
//     AND resolve inside that directory under the project root, and its sha256
//     must be the sha256 of its body — else REFUSED (nothing written);
//   - a project file whose CURRENT sha256 is neither the recorded one nor the
//     incoming one is an UNSYNCED LOCAL EDIT: it is NEVER overwritten — skipped,
//     listed under `project.conflicts`, exit 1 — the user runs /hub:sync first;
//   - a `project.removed` path only DROPS the `.versions.json` record — a
//     customer file is never deleted by this script (v1 has no delete);
//   - NEVER a network call; prints one JSON line { written, removed, promoted,
//     refused, project?: { written, dropped, refused, conflicts: [path] } } —
//     the `project` key appears only when the input carried a project tier.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RULE_PATH = /^[A-Za-z0-9][A-Za-z0-9-]*\.md$/;
const MANIFEST_FILE = '.manifest.json';
const OVERRIDES_DIR = 'overrides';
/** The project tier's home inside the customer repo (US-019). */
const PROJECT_RULES_DIR = '.project-management/rules/';
const VERSIONS_FILE = '.versions.json';

function flagValue(argv, name) {
  const flag = argv.indexOf(name);
  return flag !== -1 && argv[flag + 1] ? path.resolve(argv[flag + 1]) : null;
}

function cacheDirFrom(argv, env) {
  const flagged = flagValue(argv, '--cache');
  if (flagged) return flagged;
  if (env.CLAUDE_PLUGIN_ROOT) return path.resolve(env.CLAUDE_PLUGIN_ROOT, 'rules-cache');
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rules-cache');
}

function projectRootFrom(argv, cwd) {
  return flagValue(argv, '--project-root') ?? path.resolve(cwd);
}

function readDeltas(stdin) {
  const parsed = JSON.parse(stdin);
  const deltas = parsed?.directive?.rule_deltas ?? parsed?.rule_deltas ?? parsed;
  if (!Array.isArray(deltas?.changed) || !Array.isArray(deltas?.removed)) {
    throw new Error('stdin is not a rule_deltas object ({ manifest_sha256, changed, removed })');
  }
  return deltas;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function readManifest(cacheDir) {
  const file = path.join(cacheDir, MANIFEST_FILE);
  if (!existsSync(file)) return { files: {} };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return { manifest_sha256: parsed.manifest_sha256, files: { ...(parsed.files ?? {}) } };
}

function writeManifest(cacheDir, manifest) {
  const files = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const out =
    manifest.manifest_sha256 === undefined
      ? { files }
      : { manifest_sha256: manifest.manifest_sha256, files };
  writeFileSync(path.join(cacheDir, MANIFEST_FILE), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

/** Absolute target for a delta path, or null when it must be refused. */
function resolveInside(cacheDir, relPath) {
  if (typeof relPath !== 'string' || !RULE_PATH.test(relPath)) return null;
  const target = path.resolve(cacheDir, relPath);
  return target.startsWith(cacheDir + path.sep) && path.dirname(target) === cacheDir
    ? target
    : null;
}

/** A free override name: <name>.local.md, then <name>.local-2.md, -3, ... */
function overridePath(cacheDir, relPath) {
  const base = relPath.slice(0, -'.md'.length);
  const dir = path.join(cacheDir, OVERRIDES_DIR);
  for (let n = 1; ; n += 1) {
    const candidate = path.join(dir, n === 1 ? `${base}.local.md` : `${base}.local-${n}.md`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** Moves a locally edited cached file to overrides/. Returns true when promoted. */
function promoteIfEdited(cacheDir, relPath, target, lastDelivered) {
  if (!existsSync(target)) return false;
  if (sha256(readFileSync(target, 'utf8')) === lastDelivered) return false;
  mkdirSync(path.join(cacheDir, OVERRIDES_DIR), { recursive: true });
  renameSync(target, overridePath(cacheDir, relPath));
  return true;
}

// --- project tier (US-019) ---------------------------------------------------

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

function hasProjectTier(deltas) {
  return Array.isArray(deltas.project?.changed) && Array.isArray(deltas.project?.removed);
}

// --- framework tier (US-018) -------------------------------------------------

export function applyRuleDeltas(deltas, cacheDir, projectRoot = process.cwd()) {
  mkdirSync(cacheDir, { recursive: true });
  const manifest = readManifest(cacheDir);
  const summary = { written: 0, removed: 0, promoted: 0, refused: 0 };
  let mutated = false;

  for (const entry of deltas.changed) {
    const target = resolveInside(cacheDir, entry?.path);
    if (target === null || typeof entry.body !== 'string') {
      summary.refused += 1;
      continue;
    }
    if (promoteIfEdited(cacheDir, entry.path, target, manifest.files[entry.path]))
      summary.promoted += 1;
    writeFileSync(target, entry.body, 'utf8');
    manifest.files[entry.path] = sha256(entry.body);
    summary.written += 1;
    mutated = true;
  }

  for (const relPath of deltas.removed) {
    const target = resolveInside(cacheDir, relPath);
    if (target === null) {
      summary.refused += 1;
      continue;
    }
    if (promoteIfEdited(cacheDir, relPath, target, manifest.files[relPath])) summary.promoted += 1;
    if (existsSync(target)) unlinkSync(target);
    if (relPath in manifest.files) delete manifest.files[relPath];
    summary.removed += 1;
    mutated = true;
  }

  if (
    typeof deltas.manifest_sha256 === 'string' &&
    deltas.manifest_sha256 !== manifest.manifest_sha256
  ) {
    manifest.manifest_sha256 = deltas.manifest_sha256;
    mutated = true;
  }
  if (mutated || !existsSync(path.join(cacheDir, MANIFEST_FILE))) writeManifest(cacheDir, manifest);
  if (hasProjectTier(deltas)) summary.project = applyProjectDeltas(deltas.project, projectRoot);
  return summary;
}

/** Exit 1 when anything was refused or a project file was skipped as an unsynced edit. */
function exitCodeFor(summary) {
  const project = summary.project ?? { refused: 0, conflicts: [] };
  return summary.refused > 0 || project.refused > 0 || project.conflicts.length > 0 ? 1 : 0;
}

/**
 * Reads ALL of stdin synchronously — robust on a non-blocking PIPE.
 *
 * `readFileSync(0)` throws `EAGAIN` once the piped payload exceeds the OS pipe
 * buffer (~64 KB): the first `/hub:claim` streams the whole framework tier (~430 KB)
 * in on stdin, so it reliably crashed. This drains fd 0 in a `readSync` loop instead,
 * retrying on EAGAIN (data not yet available) and stopping at EOF (0 bytes read).
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
    readDeltas(readStdinSync()),
    cacheDirFrom(argv, process.env),
    projectRootFrom(argv, process.cwd()),
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = exitCodeFor(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
