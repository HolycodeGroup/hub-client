#!/usr/bin/env node
// Story worktrees (HH-90) — one git worktree and branch per claimed Hub story, so a developer can
// work several stories in parallel without cloning the repository again. The command stubs call this
// script; it does the git work deterministically and prints one JSON object for the stub to relay.
//
//   create  --key K --title T [--type feat] [--limit N] [--expires ISO] [--group LEAD]
//           a worktree on `<type>/<key>-<slug>` in `<repo>.worktrees/<key>` beside the repository;
//           refused while the main checkout has uncommitted changes, or when the member already has
//           `--limit` story worktrees (the concurrent-story limit from the claim's lease). A story
//           that already has a worktree (a re-claim) gets the same one back with a fresh lease.
//           HH-245 — `--group LEAD` joins the worktree and branch of story LEAD instead: a parallel
//           run keeps stories that depend on each other or share files in one group, one branch, one PR.
//           HH-679 — `--tool claude-code|pi` names the calling client: when the other client has a
//           live session in the worktree, the result carries its `warning` (tool-sessions.mjs).
//   remove  --key K   removes the worktree once its branch is pushed (nothing unpushed) or merged
//                     into the default branch, and it holds no uncommitted change; the branch stays.
//                     A group's worktree stays while another story of the group still uses it.
//   check             lists story worktrees whose lease has expired — never touches them.
//   keep    --key K   the developer chose to keep an expired story's branch: the worktree goes, the
//                     branch and its commits stay; refused while the worktree has uncommitted changes.
//   busy    --key K --tool T   (HH-679, read only) `{ warning }` when the other client has a live
//                     session in the story's recorded worktree, else `{}` — run before a claim.
//   hook              (PostToolUse) a work_* call renews the recorded lease of its story's worktree.
//
// The registry lives in the repository's git directory (`<git-common-dir>/holycode-hub/worktrees.json`)
// — per repository, never committed. Work is never deleted: every removal is refused unless the
// worktree is clean and its commits are safe on a remote or merged.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { folderWarning } from './tool-sessions.mjs';

/** A lease the Hub granted lasts 8 h and is renewed by every work_* call on the story. */
export const LEASE_TTL_MS = 8 * 60 * 60 * 1000;
/** Git never hangs a command (background-work.md — explicit timeouts). */
const GIT_TIMEOUT_MS = 30_000;
/** The longest slug kept in a branch name. */
const SLUG_MAX = 48;

/** `feat/hh-90-one-git-worktree-per-claimed-story` — kebab-case, the story key first. */
export function branchName(type, key, title) {
  const slug = String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  const head = `${type}/${String(key).toLowerCase()}`;
  return slug === '' ? head : `${head}-${slug}`;
}

/** Runs git in `cwd` and returns its trimmed stdout. */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(cwd, args) {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** The main checkout (the first `git worktree list` entry) and the shared git directory. */
export function repoOf(cwd) {
  const main = git(cwd, ['worktree', 'list', '--porcelain']).split('\n')[0]?.replace(/^worktree /, '') ?? cwd;
  const commonDir = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
  return { main, registryFile: path.join(commonDir, 'holycode-hub', 'worktrees.json') };
}

export function loadRegistry(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRegistry(file, registry) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2));
  renameSync(tmp, file);
}

/** Uncommitted changes in a checkout (tracked or untracked). */
function isDirty(cwd) {
  return git(cwd, ['status', '--porcelain']) !== '';
}

/** The default branch to branch from and to test "merged" against: origin's HEAD, else main/master. */
function defaultBase(cwd) {
  try {
    return git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  } catch {
    return ['origin/main', 'main', 'origin/master', 'master'].find((ref) => gitOk(cwd, ['rev-parse', '--verify', '--quiet', ref])) ?? 'HEAD';
  }
}

/**
 * Creates (or, on a re-claim, returns) the story's worktree; with `group`, joins that story's (HH-245).
 * With `tool`, a successful result carries `warning` while the other client works in it (HH-679).
 *
 * @returns {{ ok: true, path: string, branch: string, reused: boolean, group?: string, warning?: string } | { ok: false, reason: string }}
 */
export function create(cwd, options, now = Date.now()) {
  const result = createWorktree(cwd, options, now);
  if (!result.ok || options.tool === undefined || options.tool === null) return result;
  const warning = folderWarning(result.path, options.tool, { now });
  return warning === null ? result : { ...result, warning };
}

function createWorktree(cwd, { key, title, type = 'feat', limit = null, expires = null, group = null }, now) {
  const { main, registryFile } = repoOf(cwd);
  const registry = loadRegistry(registryFile);
  const leaseExpiresAt = expires === null ? now + LEASE_TTL_MS : Date.parse(expires);
  const existing = registry[key];
  if (existing !== undefined && existsSync(existing.path)) {
    registry[key] = { ...existing, leaseExpiresAt };
    saveRegistry(registryFile, registry);
    return { ok: true, path: existing.path, branch: existing.branch, reused: true };
  }
  if (group !== null) return joinGroup(registryFile, registry, { key, group, leaseExpiresAt });
  if (isDirty(main)) {
    return { ok: false, reason: `The main checkout (${main}) has uncommitted changes. Commit or stash them first.` };
  }
  // A group's stories share one worktree, so the limit counts worktrees, not registry entries.
  const live = new Set(Object.values(registry).filter((entry) => existsSync(entry.path)).map((entry) => entry.path));
  if (limit !== null && live.size >= limit) {
    return { ok: false, reason: `You already have ${live.size} story worktree(s), your limit of stories at once. Complete or release one first.` };
  }
  const branch = branchName(type, key, title);
  const target = path.join(`${main}.worktrees`, String(key).toLowerCase());
  const branchExists = gitOk(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  // --no-track: the story branch must not track the default branch, so "pushed" means pushed itself.
  git(main, branchExists ? ['worktree', 'add', target, branch] : ['worktree', 'add', '--no-track', '-b', branch, target, defaultBase(main)]);
  registry[key] = { path: target, branch, leaseExpiresAt };
  saveRegistry(registryFile, registry);
  return { ok: true, path: target, branch, reused: false };
}

/**
 * HH-245 — records `key` in the worktree and branch of the group's lead story. No new worktree is
 * made, so neither the dirty-checkout guard nor the worktree limit applies.
 *
 * @returns {{ ok: true, path: string, branch: string, reused: false, group: string } | { ok: false, reason: string }}
 */
function joinGroup(registryFile, registry, { key, group, leaseExpiresAt }) {
  const lead = registry[group];
  if (lead === undefined || !existsSync(lead.path)) {
    return { ok: false, reason: `No worktree is recorded for ${group}. Claim ${group} first, or create this story's worktree without --group.` };
  }
  registry[key] = { path: lead.path, branch: lead.branch, leaseExpiresAt, group };
  saveRegistry(registryFile, registry);
  return { ok: true, path: lead.path, branch: lead.branch, reused: false, group };
}

/** Other stories still recorded in the same worktree (a group), in key order. */
function sharingKeys(registry, key) {
  const entry = registry[key];
  return Object.keys(registry)
    .filter((other) => other !== key && registry[other].path === entry.path)
    .sort();
}

/** Why the worktree may not go yet, or null when its work is safe (clean + pushed or merged). */
function unsafeToRemove(entry, main) {
  if (!existsSync(entry.path)) return null;
  if (isDirty(entry.path)) return `${entry.path} has uncommitted changes.`;
  const merged = gitOk(main, ['merge-base', '--is-ancestor', entry.branch, defaultBase(main)]);
  if (merged) return null;
  let unpushed;
  try {
    unpushed = git(entry.path, ['rev-list', '--count', '@{upstream}..HEAD']);
  } catch {
    return `${entry.branch} has not been pushed yet.`;
  }
  return unpushed === '0' ? null : `${entry.branch} has ${unpushed} commit(s) not pushed yet.`;
}

function dropWorktree(cwd, key, check) {
  const { main, registryFile } = repoOf(cwd);
  const registry = loadRegistry(registryFile);
  const entry = registry[key];
  if (entry === undefined) return { ok: true, removed: false, reason: 'No worktree is recorded for this story.' };
  const sharedWith = sharingKeys(registry, key);
  if (sharedWith.length > 0) {
    // The group still works here: only this story leaves the registry; the worktree and branch stay.
    delete registry[key];
    saveRegistry(registryFile, registry);
    return { ok: true, removed: false, path: entry.path, branch: entry.branch, sharedWith };
  }
  const reason = check(entry, main);
  if (reason !== null) return { ok: false, removed: false, path: entry.path, branch: entry.branch, reason };
  if (existsSync(entry.path)) git(main, ['worktree', 'remove', entry.path]);
  delete registry[key];
  saveRegistry(registryFile, registry);
  return { ok: true, removed: true, path: entry.path, branch: entry.branch };
}

/** After complete / release: removes the worktree once its branch is pushed or merged; never loses work. */
export function remove(cwd, key) {
  return dropWorktree(cwd, key, unsafeToRemove);
}

/** Keep-the-branch for an expired story: the worktree goes, the branch and its commits stay. */
export function keep(cwd, key) {
  return dropWorktree(cwd, key, (entry) => (existsSync(entry.path) && isDirty(entry.path) ? `${entry.path} has uncommitted changes.` : null));
}

/** The story worktrees whose lease has expired (nothing is changed). */
export function check(cwd, now = Date.now()) {
  const registry = loadRegistry(repoOf(cwd).registryFile);
  return Object.entries(registry)
    .filter(([, entry]) => existsSync(entry.path) && entry.leaseExpiresAt < now)
    .map(([key, entry]) => ({ key, path: entry.path, branch: entry.branch, expiredAt: new Date(entry.leaseExpiresAt).toISOString() }));
}

/** HH-679 — the other client's live session in the story's recorded worktree, read only: `{ warning? }`. */
export function busy(cwd, key, tool, now = Date.now()) {
  const entry = loadRegistry(repoOf(cwd).registryFile)[key];
  if (entry === undefined || !existsSync(entry.path)) return {};
  const warning = folderWarning(entry.path, tool, { now });
  return warning === null ? {} : { warning };
}

/** PostToolUse: a successful work_* call on a story renews its recorded lease. */
export function applyHook(cwd, event, now = Date.now()) {
  const tool = String(event.tool_name ?? '');
  if (!/__work_(claim|progress|verify)$/.test(tool)) return;
  const key = event.tool_input?.story_id;
  if (typeof key !== 'string') return;
  const { registryFile } = repoOf(cwd);
  const registry = loadRegistry(registryFile);
  if (registry[key] === undefined) return;
  registry[key] = { ...registry[key], leaseExpiresAt: now + LEASE_TTL_MS };
  saveRegistry(registryFile, registry);
}

/** `--name value` pairs → an object. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, '')] = argv[i + 1];
  return out;
}

function main(argv, stdin, cwd) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'create':
      return create(cwd, {
        key: args.key,
        title: args.title ?? '',
        type: args.type ?? 'feat',
        limit: args.limit === undefined || args.limit === 'null' ? null : Number(args.limit),
        expires: args.expires ?? null,
        group: args.group ?? null,
        tool: args.tool ?? null,
      });
    case 'remove':
      return remove(cwd, args.key);
    case 'keep':
      return keep(cwd, args.key);
    case 'check':
      return check(cwd);
    case 'busy':
      return busy(cwd, args.key, args.tool);
    case 'hook': {
      const event = JSON.parse(stdin || '{}');
      applyHook(event.cwd ?? cwd, event);
      return null;
    }
    default:
      return { ok: false, reason: `Unknown command: ${command ?? '(none)'}` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const hook = process.argv[2] === 'hook';
  try {
    const result = main(process.argv.slice(2), hook ? readFileSync(0, 'utf8') : '', process.cwd());
    if (result !== null) process.stdout.write(JSON.stringify(result));
  } catch (err) {
    // A hook never blocks a session; a command reports the failure as JSON for the stub to relay.
    if (!hook) process.stdout.write(JSON.stringify({ ok: false, reason: err instanceof Error ? err.message.split('\n')[0] : 'git failed' }));
  }
}
