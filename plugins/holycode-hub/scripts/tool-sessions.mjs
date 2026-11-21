#!/usr/bin/env node
// Switching between Claude Code and Pi (HH-679, HH-680) — what each client keeps on this machine so
// the other one can warn, never block:
//
//   session markers  <git-common-dir>/holycode-hub/sessions/<folder-hash>/<tool>-<pid>.json
//                    { tool, pid, host, started_at, heartbeat_at } — one file per running session of
//                    a folder (a worktree's top level). One file per session, not one per folder:
//                    two sessions in one folder (two Claude Code windows, a Pi session beside a Pi
//                    worker) each write and remove only their own file, so no write ever races
//                    another session's and ending one session never drops the other's marker.
//                    A marker is LIVE when its host is this machine, its pid runs and its heartbeat
//                    is under 10 minutes old; any other marker is stale — ignored and deleted.
//   Hub records      <git-common-dir>/holycode-hub/hub.json
//                    { "<tool>": { url, tool, recorded_at } } — the Hub URL each client uses for this
//                    repository (the URL only, never a token). A record older than 30 days is ignored.
//
// Both files live in the repository's git directory, so every worktree of one repository shares them
// and nothing is ever committed. They hold no prompt text, code or credential, and no client sends
// them anywhere (no network call in this file).
//
// The Claude Code plugin runs this file from its hooks (`hook --tool claude-code`); the Pi extension
// imports its functions. Zero dependencies (Node ESM stdlib only); the source of truth is
// hub-client-core, the clients ship byte copies.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

/** The clients and the names a developer reads. */
export const TOOL_NAMES = Object.freeze({ 'claude-code': 'Claude Code', pi: 'Pi' });
/** A marker whose heartbeat is older than this is stale. */
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
/** A heartbeat rewrites the marker only when the last one is older than this (hooks fire often). */
export const HEARTBEAT_REFRESH_MS = 60 * 1000;
/** A Hub record older than this is ignored. */
export const HUB_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Git and ps never hang a session start (background-work.md — explicit timeouts). */
const COMMAND_TIMEOUT_MS = 3_000;
/** How far up the process tree the Claude Code process is looked for. */
const ANCESTOR_DEPTH_MAX = 8;
/** A Hub record lost to a simultaneous write of the other client is written again, this often at most. */
const HUB_WRITE_ATTEMPTS = 3;
/** The processes between a hook and Claude Code itself: the shells that run the hook command. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'env', 'cmd.exe', 'powershell.exe', 'pwsh']);

/** The folder a session works in (its worktree's top level) and the repository's state directory. */
export function folderOf(cwd) {
  try {
    const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const folder = realpathSync(run(['rev-parse', '--show-toplevel']));
    const stateDir = path.join(realpathSync(path.resolve(cwd, run(['rev-parse', '--git-common-dir']))), 'holycode-hub');
    return { folder, stateDir };
  } catch {
    // Outside a git repository there is no shared place for markers: nothing is written or warned.
    return null;
  }
}

/** The per-folder marker directory: `<stateDir>/sessions/<sha256(folder)[0..16]>`. */
export function sessionsDirFor(stateDir, folder) {
  return path.join(stateDir, 'sessions', createHash('sha256').update(folder).digest('hex').slice(0, 16));
}

/** True while a process with this id runs (EPERM: it runs under another user). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Live: this machine, a running pid and a heartbeat under 10 minutes old. */
export function isLive(marker, { now = Date.now(), host = hostname(), alive = pidAlive } = {}) {
  const beat = Date.parse(marker?.heartbeat_at ?? '');
  return marker?.host === host && Number.isFinite(beat) && now - beat < HEARTBEAT_STALE_MS && alive(marker.pid);
}

/** Writes `file` through a uniquely named temp file and a rename, so a reader never sees half of it. */
export function writeAtomically(file, text, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function markerFile(dir, tool, pid) {
  return path.join(dir, `${tool}-${pid}.json`);
}

function locate(cwd) {
  const where = folderOf(cwd);
  return where === null ? null : { ...where, dir: sessionsDirFor(where.stateDir, where.folder) };
}

/** Writes (or refreshes) this session's marker; keeps its start time. Returns it, or null outside git. */
export function writeMarker(cwd, { tool, pid, now = Date.now(), host = hostname() }) {
  const where = locate(cwd);
  if (where === null) return null;
  const file = markerFile(where.dir, tool, pid);
  const previous = readJson(file);
  const at = new Date(now).toISOString();
  const started = previous?.host === host && typeof previous?.started_at === 'string' ? previous.started_at : at;
  const marker = { tool, pid, host, started_at: started, heartbeat_at: at };
  writeAtomically(file, `${JSON.stringify(marker)}\n`);
  return marker;
}

/** The heartbeat: rewrites the marker when the last beat is a minute old (or it is missing). */
export function heartbeat(cwd, { tool, pid, now = Date.now(), host = hostname() }) {
  const where = locate(cwd);
  if (where === null) return null;
  const current = readJson(markerFile(where.dir, tool, pid));
  const beat = Date.parse(current?.heartbeat_at ?? '');
  if (Number.isFinite(beat) && now - beat < HEARTBEAT_REFRESH_MS) return current;
  return writeMarker(cwd, { tool, pid, now, host });
}

/** Ends the session: removes its own marker only. */
export function removeMarker(cwd, { tool, pid }) {
  const where = locate(cwd);
  if (where !== null) rmSync(markerFile(where.dir, tool, pid), { force: true });
}

/** The live markers of a folder, oldest first; stale or unreadable markers are deleted (replaced). */
export function liveSessions(folderPath, options = {}) {
  const where = locate(folderPath);
  if (where === null) return [];
  let names;
  try {
    names = readdirSync(where.dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const live = [];
  for (const name of names) {
    const file = path.join(where.dir, name);
    const marker = readJson(file);
    if (marker !== null && isLive(marker, options)) live.push(marker);
    else rmSync(file, { force: true });
  }
  return live.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

/** The live sessions of the OTHER tool in a folder — the same tool never warns about itself. */
export function otherToolSessions(folderPath, tool, options = {}) {
  return liveSessions(folderPath, options).filter((marker) => marker.tool !== tool);
}

/** `14:05` — or `2026-11-20 14:05` when the session started on another day. */
export function sinceLabel(iso, now = Date.now()) {
  const start = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const today = new Date(now);
  const sameDay = start.toDateString() === today.toDateString();
  return sameDay ? time : `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${time}`;
}

function toolName(tool) {
  return TOOL_NAMES[tool] ?? String(tool);
}

/** The warning for the other tool's live sessions (the oldest names the time), or null. */
export function sessionWarning(sessions, now = Date.now()) {
  const first = sessions[0];
  if (first === undefined) return null;
  const other = toolName(first.tool);
  return `${other} is already working in this folder (since ${sinceLabel(first.started_at, now)}). Two tools editing the same files overwrite each other: finish or close the ${other} session first.`;
}

/** The warning for a folder another tool works in, from `tool`'s point of view, or null. */
export function folderWarning(folderPath, tool, options = {}) {
  return sessionWarning(otherToolSessions(folderPath, tool, options), options.now);
}

/** `https://rdhub.holycode.com` — the origin a Hub is compared and named by. */
export function hubOrigin(url) {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return String(url).trim().replace(/\/+$/, '');
  }
}

function hubFile(stateDir) {
  return path.join(stateDir, 'hub.json');
}

function readRecords(stateDir) {
  const parsed = readJson(hubFile(stateDir));
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/**
 * Records the Hub URL `tool` uses for this repository (the URL only). Both clients write the file; a
 * record lost to the other client's simultaneous write is written again.
 */
export function recordHub(cwd, { tool, url, now = Date.now() }) {
  const where = folderOf(cwd);
  if (where === null) return null;
  const record = { url, tool, recorded_at: new Date(now).toISOString() };
  for (let attempt = 0; attempt < HUB_WRITE_ATTEMPTS; attempt += 1) {
    writeAtomically(hubFile(where.stateDir), `${JSON.stringify({ ...readRecords(where.stateDir), [tool]: record }, null, 2)}\n`);
    if (readRecords(where.stateDir)[tool]?.recorded_at === record.recorded_at) break;
  }
  return record;
}

/** The other tool's record when it names another Hub and is under 30 days old, else null. */
export function hubMismatch(cwd, { tool, url, now = Date.now() }) {
  const where = folderOf(cwd);
  if (where === null) return null;
  for (const [otherTool, record] of Object.entries(readRecords(where.stateDir))) {
    if (otherTool === tool || typeof record?.url !== 'string') continue;
    const age = now - Date.parse(record.recorded_at ?? '');
    if (!(age >= 0 && age < HUB_RECORD_MAX_AGE_MS)) continue;
    if (hubOrigin(record.url) !== hubOrigin(url)) return { tool: otherTool, url: record.url, recorded_at: record.recorded_at };
  }
  return null;
}

/** The fix for each client, pointing it at `url`. */
function hubFix(tool, url) {
  if (tool === 'pi') return `To make Pi use ${hubOrigin(url)}: set the holycode-hub url in the project's .pi/mcp.json, or run: pi mcp add -l holycode-hub --url ${url} — then restart Pi.`;
  return `To make Claude Code use ${hubOrigin(url)}: set the url of the holycode-hub MCP server to ${url} in the holycode-hub plugin's .mcp.json — then restart Claude Code.`;
}

/** The warning lines when the two clients use different Hubs for this repository. */
export function hubWarningLines({ tool, url }, other) {
  return [
    `${toolName(other.tool)} uses ${hubOrigin(other.url)} for this repository, but ${toolName(tool)} uses ${hubOrigin(url)}. Claims made in one are not visible in the other.`,
    hubFix(tool, other.url),
    hubFix(other.tool, url),
  ];
}

/**
 * The session start: writes this session's marker, records its Hub, and returns every warning — the
 * other tool working in this folder (HH-679) and the other tool using another Hub (HH-680).
 *
 * @param {string} cwd
 * @param {{ tool: string, pid: number, hubUrl?: string | null, now?: number, host?: string, alive?: (pid: number) => boolean }} options
 * @returns {string[]}
 */
export function startSession(cwd, { tool, pid, hubUrl = null, now = Date.now(), host = hostname(), alive = pidAlive }) {
  if (folderOf(cwd) === null) return [];
  const options = { now, host, alive };
  const warnings = [];
  const busy = folderWarning(cwd, tool, options);
  if (busy !== null) warnings.push(busy);
  writeMarker(cwd, { tool, pid, now, host });
  if (typeof hubUrl === 'string' && hubUrl !== '') {
    const other = hubMismatch(cwd, { tool, url: hubUrl, now });
    if (other !== null) warnings.push(...hubWarningLines({ tool, url: hubUrl }, other));
    recordHub(cwd, { tool, url: hubUrl, now });
  }
  return warnings;
}

/** `ps` for one process: its parent and command name, or null. */
function psEntry(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(out);
    return match === null ? null : { ppid: Number(match[1]), comm: match[2] };
  } catch {
    return null;
  }
}

/**
 * The long-lived Claude Code process a hook belongs to. A hook is a short-lived child: Claude Code
 * runs its command through a shell (which may exec the command itself), and session-start.sh adds one
 * more shell. Walking up from the hook's parent past every shell lands on Claude Code — `claude`, or
 * `node` for an npm install. Without `ps` (Windows) the hook's parent is used.
 */
export function sessionPid(startPid = process.ppid, entryOf = psEntry) {
  let pid = startPid;
  for (let depth = 0; depth < ANCESTOR_DEPTH_MAX; depth += 1) {
    const entry = entryOf(pid);
    if (entry === null) return pid;
    const name = path.basename(entry.comm.replace(/^-/, ''));
    if (!SHELLS.has(name) || entry.ppid <= 1) return pid;
    pid = entry.ppid;
  }
  return pid;
}

/** The url of the holycode-hub server in an MCP config file (`.mcp.json`), or null. */
export function hubUrlInConfig(file) {
  const url = readJson(file)?.mcpServers?.['holycode-hub']?.url;
  return typeof url === 'string' && url !== '' ? url : null;
}

/** `--name value` pairs → an object. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, '')] = argv[i + 1];
  return out;
}

/**
 * One Claude Code hook event → the hook's stdout. SessionStart writes the marker, records the Hub and
 * shows the warnings (to the developer as a system message, to the agent as context); a prompt, a
 * finished turn or a tool step beats the heartbeat; SessionEnd removes the marker.
 */
export function runHook(event, { tool, mcpConfig = null, pid = sessionPid(), now = Date.now() }) {
  const cwd = typeof event.cwd === 'string' && event.cwd !== '' ? event.cwd : process.cwd();
  switch (event.hook_event_name) {
    case 'SessionStart': {
      const hubUrl = mcpConfig === null ? null : hubUrlInConfig(mcpConfig);
      const warnings = startSession(cwd, { tool, pid, hubUrl, now });
      if (warnings.length === 0) return '';
      const text = warnings.map((line) => `holycode-hub: ${line}`).join('\n');
      return JSON.stringify({
        systemMessage: text,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${text}\nholycode-hub: tell the developer this before any work.` },
      });
    }
    case 'SessionEnd':
      removeMarker(cwd, { tool, pid });
      return '';
    case 'UserPromptSubmit':
    case 'Stop':
    case 'PostToolUse':
      heartbeat(cwd, { tool, pid, now });
      return '';
    default:
      return '';
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // A hook never blocks a session: any failure is swallowed (exit 0, nothing printed).
  try {
    const [command, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);
    if (command === 'hook' && typeof args.tool === 'string') {
      const event = JSON.parse(readFileSync(0, 'utf8') || '{}');
      process.stdout.write(runHook(event, { tool: args.tool, mcpConfig: args['mcp-config'] ?? null }));
    }
  } catch {
    // nothing to report — the session carries on
  }
}
