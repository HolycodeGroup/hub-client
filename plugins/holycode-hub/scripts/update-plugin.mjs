#!/usr/bin/env node
// Plugin self-update (HH-159) — refreshes the holycode-hub marketplace, then updates this plugin to
// the published version through the Claude Code CLI, and reports the version change. It replaces
// the four manual /plugin steps the outdated-plugin message used to list.
//
// Both steps run `claude plugin … --json` with a timeout and read its one-line JSON result. It never
// passes `--yes`: when a marketplace declares an install command, a person must confirm it, so the
// step fails and the report says so. It makes no Hub call and changes nothing but what the CLI does.
// A restart is still needed — Claude Code loads plugins only at startup.
//
// HH-247 — after an update it also resolves the NEW version's plugin directory from
// `claude plugin list --json` (the installed entry with the new version) and checks that it exists,
// so the update card can sync the command cards into that directory's empty `commands-cache/`. It
// never guesses a path: when the CLI does not name an existing directory, the report says so.
//
// CLI: `update-plugin.mjs`. Exit 0 = updated or already current; exit 1 = a step failed (the report
// names it and prints the manual steps).
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const MARKETPLACE = 'holycode-hub';
export const PLUGIN_ID = 'holycode-hub@holycode-hub';
/** A marketplace refresh is a git clone; the CLI's own clone timeout is 120 s. */
export const STEP_TIMEOUT_MS = 180_000;

export const MANUAL_STEPS = [
  `/plugin marketplace update ${MARKETPLACE}`,
  `/plugin uninstall ${PLUGIN_ID}`,
  `/plugin install ${PLUGIN_ID}`,
  'restart Claude Code',
];

/** Runs `claude <args>`; tests pass their own runner. */
export function realRun(args) {
  const out = spawnSync('claude', args, { encoding: 'utf8', timeout: STEP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: out.status, stdout: out.stdout ?? '', error: out.error ?? null };
}

/** The last stdout line that parses as a JSON object (the CLI's `--json` result), or null. */
export function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // not the result line — keep looking
    }
  }
  return null;
}

/** The JSON array the CLI prints for `--json` listings, or null. */
export function jsonArray(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True when `dir` is an existing directory; tests pass their own check. */
export function realIsDir(dir) {
  return existsSync(dir) && statSync(dir).isDirectory();
}

/**
 * The installed directory of `version` as the CLI lists it, verified to exist.
 *
 * @returns {{ pluginDir: string } | { pluginDirError: string }}
 */
export function resolvePluginDir(version, run = realRun, isDir = realIsDir) {
  const out = run(['plugin', 'list', '--json']);
  const entries = out.status === 0 && !out.error ? jsonArray(out.stdout) : null;
  if (entries === null) return { pluginDirError: '`claude plugin list --json` gave no plugin list' };
  const entry = entries.find((e) => e?.id === PLUGIN_ID && e?.version === version);
  if (typeof entry?.installPath !== 'string') return { pluginDirError: `the CLI lists no ${PLUGIN_ID} ${version} install` };
  if (!isDir(entry.installPath)) return { pluginDirError: `the listed directory ${entry.installPath} does not exist` };
  return { pluginDir: entry.installPath };
}

/** The last non-empty line of a CLI message — the line that says what happened. */
function lastLine(message) {
  const lines = String(message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? 'no reason given';
}

/** Runs one step; returns its JSON result, or the failure (`step`, `reason`). */
function runStep(run, step, args) {
  const out = run(args);
  if (out.error?.code === 'ENOENT') return { failure: { step: 'cli', reason: 'the Claude Code CLI (`claude`) is not on the PATH' } };
  if (out.error?.code === 'ETIMEDOUT') return { failure: { step, reason: `timed out after ${STEP_TIMEOUT_MS / 1000} s` } };
  const result = lastJsonLine(out.stdout);
  if (out.status !== 0 || result?.outcome !== 'ok') {
    return { failure: { step, reason: result ? lastLine(result.message) : `exit code ${out.status ?? 'unknown'}` } };
  }
  return { result };
}

/**
 * Refreshes the marketplace, then updates the plugin; after an update, resolves the new version's
 * plugin directory (`pluginDir`, or `pluginDirError` saying why it could not).
 *
 * @returns {{ ok: true, oldVersion: string, newVersion: string, upToDate: boolean, pluginDir?: string, pluginDirError?: string } | { ok: false, step: 'cli'|'marketplace'|'plugin', reason: string }}
 */
export function updatePlugin(run = realRun, isDir = realIsDir) {
  const marketplace = runStep(run, 'marketplace', ['plugin', 'marketplace', 'update', MARKETPLACE, '--json']);
  if (marketplace.failure) return { ok: false, ...marketplace.failure };
  const plugin = runStep(run, 'plugin', ['plugin', 'update', PLUGIN_ID, '--json']);
  if (plugin.failure) return { ok: false, ...plugin.failure };
  const { oldVersion, newVersion, updateOutcome } = plugin.result;
  const upToDate = updateOutcome === 'up_to_date' || oldVersion === newVersion;
  if (upToDate) return { ok: true, oldVersion, newVersion, upToDate };
  return { ok: true, oldVersion, newVersion, upToDate, ...resolvePluginDir(newVersion, run, isDir) };
}

const STEP_LABEL = { cli: 'Claude Code CLI', marketplace: 'Marketplace refresh', plugin: 'Plugin update' };

/** The report the developer sees. */
export function formatResult(result) {
  if (result.ok && result.upToDate) return `✔ ${MARKETPLACE} is already current (${result.newVersion}). Nothing to restart.`;
  if (result.ok) {
    const updated = `✔ ${MARKETPLACE} updated ${result.oldVersion} → ${result.newVersion}. Restart Claude Code to load it.`;
    const dir = result.pluginDir
      ? `New plugin directory: ${result.pluginDir}`
      : `New plugin directory not found: ${result.pluginDirError}`;
    return `${updated}\n${dir}`;
  }
  return [
    `✘ ${STEP_LABEL[result.step]} failed: ${result.reason}`,
    'Update by hand instead:',
    ...MANUAL_STEPS.map((step, i) => `  ${i + 1}. ${step}`),
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = updatePlugin();
  process.stdout.write(`${formatResult(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
