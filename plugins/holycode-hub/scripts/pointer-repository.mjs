#!/usr/bin/env node
// Pointer repository (HH-476, Confluence "Multi-Repository Projects (Proposal)", design B) — the
// `**Repository ID:**` line of `.project-management/hub-pointer.md` names which of the project's
// repositories this checkout is, so every command knows where it works. The command stubs call this
// script; it does the file and git work deterministically and prints one JSON object to relay.
//
//   origin                 this checkout's `origin` URL with credentials removed (never sent with them)
//   record --id ID         writes the line (init, after project_repository_add answered the id)
//   resolve                (claim, sync-commands) a pointer without the line: reads the project's
//                          repositories as JSON on stdin (`project_status` → `project.repositories`,
//                          or the whole result), matches this checkout's origin URL and writes the
//                          line. The URL is only compared here — it never leaves the machine. With
//                          no match (HH-489) it writes nothing and answers the question the stub asks:
//                          add this checkout as a repository of the project, with a proposed kind.
//
// Nothing here talks to the Hub. A missing pointer, a missing origin or no matching repository is an
// answer for the stub to relay, never a crash.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

export const POINTER_FILE = path.join('.project-management', 'hub-pointer.md');
const LINE = /^\*\*Repository ID:\*\*\s*(\S*)\s*$/m;
const HEADER_LINE = /^\*\*[^*]+:\*\*/;
/** Git never hangs a command (background-work.md — explicit timeouts). */
const GIT_TIMEOUT_MS = 10_000;

/**
 * A remote URL without credentials: https/git lose user and password, ssh only the password (its user
 * is the login, not a secret), an scp-like `user@host:path` stays as it is.
 */
export function stripCredentials(url) {
  const value = String(url).trim();
  if (!value.includes('://')) return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value.replace(/:\/\/[^/@]*@/, '://');
  }
  parsed.password = '';
  if (parsed.protocol !== 'ssh:') parsed.username = '';
  return parsed.toString().replace(/\/$/, value.endsWith('/') ? '/' : '');
}

/** HH-488 — hosts whose owner/group/name paths are case-insensitive (plus any host containing "gitlab"). */
const CASE_INSENSITIVE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * HH-488 — a repository's identity, whichever way its URL is written: `<host>/<path>` without scheme,
 * login or credentials, port, leading `www.`, trailing `/` or `.git`; the host lower case, and the path
 * too on GitHub, GitLab (any host containing "gitlab") and Bitbucket. The SAME rule as the Hub's
 * `repositoryKey` (apps/backend/src/contracts/repository-key.ts), so the ssh and https forms of one
 * repository match.
 */
export function repositoryKey(url) {
  const value = String(url).trim();
  const withScheme = SCHEME.test(value);
  const rest = withScheme ? value.replace(SCHEME, '').replace(/^[^@/]*@/, '') : value.replace(/^[^@]*@/, '');
  const cut = rest.indexOf(withScheme ? '/' : ':');
  const rawHost = cut === -1 ? rest : rest.slice(0, cut);
  const rawPath = cut === -1 ? '' : rest.slice(cut + 1);
  const host = rawHost.toLowerCase().replace(/:[0-9]*$/, '').replace(/^www\./, '');
  const path = rawPath
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const caseInsensitive = CASE_INSENSITIVE_HOSTS.has(host) || host.includes('gitlab');
  return `${host}/${caseInsensitive ? path.toLowerCase() : path}`;
}

/** The repository id the pointer text names, or null. */
export function repositoryIdOf(text) {
  const match = LINE.exec(text);
  return match && match[1] !== '' ? match[1] : null;
}

/** The pointer text with its `**Repository ID:**` line set to `id` (replaced, or added under the header lines). */
export function withRepositoryId(text, id) {
  const line = `**Repository ID:** ${id}`;
  if (LINE.test(text)) return text.replace(LINE, line);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('**Project ID:**'));
  if (start === -1) return `${text.replace(/\n*$/, '\n')}${line}\n`;
  let end = start;
  while (end + 1 < lines.length && HEADER_LINE.test(lines[end + 1])) end += 1;
  lines.splice(end + 1, 0, line);
  return lines.join('\n');
}

/** This checkout's origin URL without credentials, or null when there is none. */
export function originUrl(cwd) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return url === '' ? null : stripCredentials(url);
  } catch {
    return null;
  }
}

function readPointer(cwd) {
  const file = path.join(cwd, POINTER_FILE);
  return existsSync(file) ? { file, text: readFileSync(file, 'utf8') } : null;
}

/** `record --id ID` — writes the line; unchanged when it already names that id. */
export function record(cwd, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return { ok: false, reason: 'record needs --id <the repository id project_repository_add returned>' };
  }
  const pointer = readPointer(cwd);
  if (pointer === null) return { ok: false, reason: `${POINTER_FILE} is missing — run /holycode-hub:init` };
  if (repositoryIdOf(pointer.text) === id) return { ok: true, status: 'unchanged', repository_id: id };
  writeFileSync(pointer.file, withRepositoryId(pointer.text, id));
  return { ok: true, status: 'written', repository_id: id };
}

/** The repositories list out of a project_status result, its `project`, or the bare list. */
export function repositoriesOf(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.repositories)) return input.repositories;
  if (Array.isArray(input?.project?.repositories)) return input.project.repositories;
  if (Array.isArray(input?.result?.project?.repositories)) return input.result.project.repositories;
  return null;
}

const KIND_HINTS = Object.freeze([
  ['MOBILE', /(^|[-_./])(mobile|ios|android|flutter|react-native|rn)([-_./]|$)/i],
  ['FRONTEND', /(^|[-_./])(frontend|front|web|ui|admin|backoffice|back-office|portal|site|webapp|client|dashboard|console)([-_./]|$)/i],
  ['SHARED', /(^|[-_./])(shared|common|contracts|lib|libs|sdk|proto|protos|packages|core)([-_./]|$)/i],
]);

/**
 * HH-489 — the kind proposed for an unknown checkout, read from the repository's name: mobile, frontend
 * and shared words first, BACKEND otherwise. Only a proposal — the developer confirms or names another.
 */
export function proposedKind(url) {
  const name = repositoryKey(url).split('/').pop() ?? '';
  const hit = KIND_HINTS.find(([, pattern]) => pattern.test(name));
  return hit === undefined ? 'BACKEND' : hit[0];
}

/** The project name out of a project_status result or its `project`, when it carries one. */
function projectNameOf(input) {
  const name = input?.project?.name ?? input?.result?.project?.name;
  return typeof name === 'string' && name !== '' ? name : 'this Hub project';
}

/** `resolve` — finds this checkout among the project's repositories and records it. */
export function resolve(cwd, input) {
  const pointer = readPointer(cwd);
  if (pointer === null) return { ok: false, status: 'no-pointer', reason: `${POINTER_FILE} is missing — run /holycode-hub:init` };
  const present = repositoryIdOf(pointer.text);
  if (present !== null) return { ok: true, status: 'present', repository_id: present };
  const repositories = repositoriesOf(input);
  if (repositories === null) return { ok: false, status: 'bad-input', reason: 'resolve reads project_status → project.repositories as JSON on stdin' };
  const url = originUrl(cwd);
  if (url === null) return { ok: true, status: 'no-origin', message: 'This checkout has no origin remote, so no repository is recorded.' };
  const wanted = repositoryKey(url);
  const match = repositories.find((r) => typeof r?.url === 'string' && repositoryKey(r.url) === wanted);
  if (match === undefined || typeof match.id !== 'string') {
    const kind = proposedKind(url);
    const kindLabel = kind.charAt(0) + kind.slice(1).toLowerCase();
    return {
      ok: false,
      status: 'no-match',
      url,
      proposed_kind: kind,
      question: `This checkout (${url}) isn't a repository of ${projectNameOf(input)}. Add it as ${kindLabel}? yes/no`,
      message: `No repository on this Hub project matches ${url}.`,
    };
  }
  writeFileSync(pointer.file, withRepositoryId(pointer.text, match.id));
  return { ok: true, status: 'added', repository_id: match.id, kind: match.kind ?? null, url };
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) continue;
    flags[rest[i].slice(2)] = rest[i + 1];
    i += 1;
  }
  return { command, flags };
}

export function main(argv, stdin, cwd) {
  const { command, flags } = parseArgs(argv);
  if (command === 'origin') {
    const url = originUrl(cwd);
    return url === null ? { ok: false, reason: 'no origin remote' } : { ok: true, url };
  }
  if (command === 'record') return record(cwd, flags.id);
  if (command === 'resolve') {
    let input;
    try {
      input = JSON.parse(stdin);
    } catch {
      return { ok: false, status: 'bad-input', reason: 'resolve reads project_status → project.repositories as JSON on stdin' };
    }
    return resolve(cwd, input);
  }
  return { ok: false, reason: 'usage: pointer-repository.mjs origin | record --id <id> | resolve < repositories.json' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  const result = main(process.argv.slice(2), command === 'resolve' ? readFileSync(0, 'utf8') : '', process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
