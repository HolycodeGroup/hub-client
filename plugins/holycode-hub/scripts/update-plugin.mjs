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
// CLI: `update-plugin.mjs`. Exit 0 = updated or already current; exit 1 = a step failed (the report
// names it and prints the manual steps).
import { spawnSync } from 'node:child_process';
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
 * Refreshes the marketplace, then updates the plugin.
 *
 * @returns {{ ok: true, oldVersion: string, newVersion: string, upToDate: boolean } | { ok: false, step: 'cli'|'marketplace'|'plugin', reason: string }}
 */
export function updatePlugin(run = realRun) {
  const marketplace = runStep(run, 'marketplace', ['plugin', 'marketplace', 'update', MARKETPLACE, '--json']);
  if (marketplace.failure) return { ok: false, ...marketplace.failure };
  const plugin = runStep(run, 'plugin', ['plugin', 'update', PLUGIN_ID, '--json']);
  if (plugin.failure) return { ok: false, ...plugin.failure };
  const { oldVersion, newVersion, updateOutcome } = plugin.result;
  return { ok: true, oldVersion, newVersion, upToDate: updateOutcome === 'up_to_date' || oldVersion === newVersion };
}

const STEP_LABEL = { cli: 'Claude Code CLI', marketplace: 'Marketplace refresh', plugin: 'Plugin update' };

/** The report the developer sees. */
export function formatResult(result) {
  if (result.ok && result.upToDate) return `✔ ${MARKETPLACE} is already current (${result.newVersion}). Nothing to restart.`;
  if (result.ok) return `✔ ${MARKETPLACE} updated ${result.oldVersion} → ${result.newVersion}. Restart Claude Code to load it.`;
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
