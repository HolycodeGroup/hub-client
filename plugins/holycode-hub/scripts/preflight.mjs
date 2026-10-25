#!/usr/bin/env node
// Environment preflight (HH-92) — checks that this machine has what the quality gates need, and
// says which gate each missing item will cause to skip. A missing local service used to surface
// only as a gate quietly reporting "skipped"; this makes it visible before any work starts.
//
// It ONLY reads: it runs version / status commands, reads env files and opens (then closes) one
// TCP connection to the database port. It never installs, starts or changes anything, and never
// prints a credential (the database is reported by host and port only).
//
// CLI: `preflight.mjs [--json]` from the repository root. Exit 0 = every required item is present;
// exit 1 = at least one is missing (the report names it and the gate it skips).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

/** No probe may hang the check (background-work.md — explicit timeouts). */
const COMMAND_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 3_000;
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const ENV_FILES = ['.env', '.env.local'];
const DEFAULT_PORTS = { postgres: 5432, postgresql: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 };

/** The real probes; tests pass their own. */
export const realProbes = {
  run(command, args) {
    try {
      const stdout = execFileSync(command, args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, stdout: stdout.trim() };
    } catch {
      return { ok: false, stdout: '' };
    }
  },
  connect(host, port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  },
  exists: (file) => existsSync(file),
  readFile: (file) => readFileSync(file, 'utf8'),
  listDir(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  isFile(file) {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
};

/** The first DATABASE_URL: the environment, else the env files at the root and in `apps/*`. */
export function findDatabaseUrl(projectDir, env, probes) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const dirs = [projectDir, ...probes.listDir(path.join(projectDir, 'apps')).map((name) => path.join(projectDir, 'apps', name))];
  for (const dir of dirs) {
    for (const file of ENV_FILES) {
      const full = path.join(dir, file);
      if (!probes.exists(full)) continue;
      const line = probes.readFile(full).split('\n').find((l) => /^\s*DATABASE_URL\s*=/.test(l));
      if (line !== undefined) return line.replace(/^\s*DATABASE_URL\s*=\s*/, '').trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

/** host + port of a database URL (never the credentials), or null when it cannot be parsed. */
export function databaseEndpoint(url) {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(/:$/, '');
    const port = parsed.port === '' ? DEFAULT_PORTS[scheme] : Number(parsed.port);
    return parsed.hostname === '' || port === undefined ? null : { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

/** Where Playwright keeps its browsers on this platform. */
export function playwrightCacheDir(env, platform, home) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

/** A Playwright Chromium download, or a Chromium / Chrome on the PATH. */
function findChromium(env, platform, home, probes) {
  const cache = playwrightCacheDir(env, platform, home);
  if (probes.listDir(cache).some((name) => /^chromium/.test(name))) return `Playwright Chromium in ${cache}`;
  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const hit = names.find((name) => probes.isFile(path.join(dir, name)));
    if (hit !== undefined) return path.join(dir, hit);
  }
  return null;
}

const item = (name, required, ok, detail, skips) => ({ name, required, status: ok ? 'ok' : required ? 'missing' : 'not-needed', detail, skips });

/**
 * Runs every check. Each result names the gate it will cause to skip when it is missing.
 *
 * @returns {Promise<{ ok: boolean, items: Array<{ name: string, required: boolean, status: 'ok'|'missing'|'not-needed', detail: string, skips: string }> }>}
 */
export async function runChecks({ projectDir, env = process.env, platform = process.platform, home = homedir(), probes = realProbes }) {
  const git = probes.run('git', ['--version']);
  const gh = probes.run('gh', ['--version']);
  const ghAuth = gh.ok ? probes.run('gh', ['auth', 'status']) : { ok: false };
  const needsDocker = COMPOSE_FILES.some((file) => probes.exists(path.join(projectDir, file)));
  const docker = needsDocker ? probes.run('docker', ['info', '--format', '{{.ServerVersion}}']) : { ok: false };
  const dbUrl = findDatabaseUrl(projectDir, env, probes);
  const endpoint = dbUrl === null ? null : databaseEndpoint(dbUrl);
  const dbReachable = endpoint === null ? false : await probes.connect(endpoint.host, endpoint.port);
  const chromium = findChromium(env, platform, home, probes);

  const items = [
    item('git', true, git.ok, git.ok ? git.stdout : 'git not found', 'commits, branches and per-story worktrees will fail'),
    item('GitHub CLI', true, gh.ok, gh.ok ? gh.stdout.split('\n')[0] : 'GitHub CLI (gh) not found', 'pull requests and CI checks will skip'),
    item('GitHub CLI sign-in', true, ghAuth.ok, ghAuth.ok ? 'signed in' : 'GitHub CLI is not signed in (gh auth login)', 'pull requests and CI checks will skip'),
    needsDocker
      ? item('Docker', true, docker.ok, docker.ok ? `daemon ${docker.stdout}` : 'Docker is not running', 'the local services and E2E environment will not start')
      : item('Docker', false, false, 'no compose file in this repository', 'nothing'),
    dbUrl === null
      ? item('Database', false, false, 'no DATABASE_URL configured', 'nothing')
      : item(
          'Database',
          true,
          dbReachable,
          endpoint === null ? 'DATABASE_URL cannot be parsed' : `${endpoint.host}:${endpoint.port} ${dbReachable ? 'reachable' : 'not reachable'}`,
          'integration tests and the runtime smoke will skip',
        ),
    item('Chromium', true, chromium !== null, chromium ?? 'Chromium not found', 'screenshot and runtime gates will skip'),
  ];
  return { ok: items.every((i) => i.status !== 'missing'), items };
}

/** The report a developer reads: one line per item; a missing one names the gate it skips. */
export function formatReport(result) {
  const lines = result.items.map((i) => {
    if (i.status === 'ok') return `✓ ${i.name}: ${i.detail}`;
    if (i.status === 'not-needed') return `– ${i.name}: ${i.detail}`;
    return `✗ ${i.detail}: ${i.skips}`;
  });
  lines.push(result.ok ? 'Everything the gates need is here.' : 'Missing items above: fix them before you rely on those gates.');
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await runChecks({ projectDir: process.cwd() });
  process.stdout.write(`${process.argv.includes('--json') ? JSON.stringify(result) : formatReport(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
