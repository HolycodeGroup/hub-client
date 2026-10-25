// Types for scripts/update-plugin.mjs (HH-159), consumed by its tests.
export type RunResult = { status: number | null; stdout: string; error: (Error & { code?: string }) | null };
export type Runner = (args: string[]) => RunResult;
export type UpdateResult =
  | { ok: true; oldVersion: string; newVersion: string; upToDate: boolean }
  | { ok: false; step: 'cli' | 'marketplace' | 'plugin'; reason: string };

export const MARKETPLACE: string;
export const PLUGIN_ID: string;
export const STEP_TIMEOUT_MS: number;
export const MANUAL_STEPS: string[];
export function realRun(args: string[]): RunResult;
export function lastJsonLine(stdout: string): Record<string, unknown> | null;
export function updatePlugin(run?: Runner): UpdateResult;
export function formatResult(result: UpdateResult): string;
