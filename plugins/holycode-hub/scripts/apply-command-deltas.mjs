#!/usr/bin/env node
// Holycode Hub — apply command-card deltas (the COMMAND tier).
// Node >= 20, ESM, ZERO dependencies.
//
// Usage:  node apply-command-deltas.mjs [--cache <dir>] < deltas.json
//   stdin = the `command_deltas` object from a work_claim result, or the whole
//   result (`.directive.command_deltas` is picked). Default cache dir:
//   ${CLAUDE_PLUGIN_ROOT}/commands-cache, else ../commands-cache next to this
//   script.
//
// The command tier is framework SURFACE, one-way Hub → client, exactly like the
// framework rule tier — the mirror of apply-rule-deltas.mjs's FRAMEWORK half,
// with NO project tier (cards are never a two-way customer artifact). It owns
// `commands-cache/.manifest.json`, written in EXACTLY the work_claim
// `command_cache` request shape — { manifest_sha256, files: { path: sha256 } },
// hashes only — so the /hub:claim stub passes it through verbatim next time.
//
// The cards themselves are the thin /hub:* command surface (a /generate-docs,
// /run-tests, … that points the agent at the synced framework rules); the
// orchestration METHOD is never delivered (it stays server-side, fingerprinted
// by the Hub's egress guard). This script only materializes surface.
//
// Invariants (tested in __tests__/apply-command-deltas.test.ts):
//   - a delta path must match the flat card shape AND resolve inside the cache
//     root, else it is REFUSED (counted, exit 1, nothing written);
//   - a cached card whose CURRENT sha256 differs from the last delivered one is
//     a LOCAL EDIT: moved to overrides/<name>.local.md (-2, -3, ... never
//     overwriting) BEFORE the canon body lands or the file is removed;
//   - NEVER a network call; prints one JSON line { written, removed, promoted, refused }.
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

const CARD_PATH = /^[A-Za-z0-9][A-Za-z0-9-]*\.md$/;
const MANIFEST_FILE = '.manifest.json';
const OVERRIDES_DIR = 'overrides';

function flagValue(argv, name) {
  const flag = argv.indexOf(name);
  return flag !== -1 && argv[flag + 1] ? path.resolve(argv[flag + 1]) : null;
}

function cacheDirFrom(argv, env) {
  const flagged = flagValue(argv, '--cache');
  if (flagged) return flagged;
  if (env.CLAUDE_PLUGIN_ROOT) return path.resolve(env.CLAUDE_PLUGIN_ROOT, 'commands-cache');
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands-cache');
}

function readDeltas(stdin) {
  const parsed = JSON.parse(stdin);
  const deltas = parsed?.directive?.command_deltas ?? parsed?.command_deltas ?? parsed;
  if (!Array.isArray(deltas?.changed) || !Array.isArray(deltas?.removed)) {
    throw new Error('stdin is not a command_deltas object ({ manifest_sha256, changed, removed })');
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
  if (typeof relPath !== 'string' || !CARD_PATH.test(relPath)) return null;
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

/** Moves a locally edited cached card to overrides/. Returns true when promoted. */
function promoteIfEdited(cacheDir, relPath, target, lastDelivered) {
  if (!existsSync(target)) return false;
  if (sha256(readFileSync(target, 'utf8')) === lastDelivered) return false;
  mkdirSync(path.join(cacheDir, OVERRIDES_DIR), { recursive: true });
  renameSync(target, overridePath(cacheDir, relPath));
  return true;
}

export function applyCommandDeltas(deltas, cacheDir) {
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
  return summary;
}

/** Exit 1 when anything was refused. */
function exitCodeFor(summary) {
  return summary.refused > 0 ? 1 : 0;
}

/**
 * Reads ALL of stdin synchronously — robust on a non-blocking PIPE.
 *
 * `readFileSync(0)` throws `EAGAIN` once the piped payload exceeds the OS pipe
 * buffer (~64 KB): the first `/hub:claim` streams the whole command tier in on
 * stdin, so it can exceed that. This drains fd 0 in a `readSync` loop instead,
 * retrying on EAGAIN (data not yet available) and stopping at EOF (0 bytes read).
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
  const summary = applyCommandDeltas(readDeltas(readStdinSync()), cacheDirFrom(argv, process.env));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = exitCodeFor(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
