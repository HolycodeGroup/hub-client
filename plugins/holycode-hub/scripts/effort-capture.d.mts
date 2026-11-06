// Types for scripts/effort-capture.mjs (HH-133), consumed by its tests.
export type EffortActor = 'HUMAN' | 'AI';
export type EffortCategory = 'PLANNING' | 'IMPLEMENTATION' | 'REVIEW_GATES' | 'WAITING_ON_ANSWER' | 'OTHER';
export type EffortSegment = { seq: number; actor: EffortActor; category: EffortCategory; started_at: string; ended_at: string };
export type UsageCounts = [model: string, input: number, output: number, cacheCreation: number, cacheRead: number];
export type EffortState = {
  story: { key: string; id?: string | null; leaseExpiresAt: number; claimedAt?: number } | null;
  step: EffortCategory;
  /** HH-292 — `until` caps AI time that runs only while background work does. */
  open: { actor: EffortActor; category: EffortCategory; since: number; until?: number } | null;
  seq: number;
  pending: EffortSegment[];
  /** HH-171 — per message id its model and counts; read offsets per transcript; the session transcript. */
  usage: { messages: Record<string, UsageCounts>; transcripts: Record<string, number>; transcript: string | null };
  /** HH-199 — the delivering tools refused once for missing effort (reset by a successful work_* call). */
  reminded?: Record<string, boolean>;
  /** HH-290 — the stories held but not measured right now, by key, each with its own pending segments and usage. */
  held: Record<string, ParkedStory>;
  /** HH-292 — the start times of background commands / agents still working (nothing else about them). */
  background: number[];
};
export type ParkedStory = {
  story: NonNullable<EffortState['story']>;
  step: EffortCategory;
  pending: EffortSegment[];
  messages: Record<string, UsageCounts>;
  parkedAt: number;
};
export type HookEvent = {
  hook_event_name: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  /** UserPromptSubmit only — read to tell a task notification from a typed prompt, never stored. */
  prompt?: string;
  /** HH-199 — set by the CLI when the work_* call failed (it delivered nothing). */
  tool_failed?: boolean;
};
export type ModelUsageSource = 'API_KEY' | 'SUBSCRIPTION' | 'BEDROCK' | 'VERTEX' | 'FOUNDRY' | 'GATEWAY' | 'UNKNOWN';
export type ModelUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  requests: number;
  source: ModelUsageSource;
};

export const IDLE_CAP_MS: number;
export const LEASE_TTL_MS: number;
export const MIN_SEGMENT_MS: number;
export const USAGE_COUNT_MAX: number;
export const USAGE_MODELS_MAX: number;
export const TRANSCRIPT_READ_MAX_BYTES: number;
export const BACKGROUND_CAP_MS: number;
export function emptyState(): EffortState;
/** HH-292 — whether a shell command runs tests / lint / typecheck / audit (not a word in a path). */
export function runsChecks(command: string): boolean;
export function stepForTool(toolName: string, toolInput: unknown, currentStep: EffortCategory): EffortCategory | null;
export function applyEvent(state: EffortState, event: HookEvent, now: number): void;
/** HH-290 — the parked story whose worktree a tool input names, or null. */
export function worktreeStoryOf(state: EffortState, toolInput: unknown): string | null;
export function take(state: EffortState, now: number): EffortSegment[];
export function usageOfLine(line: string, since: number): { id: string; counts: UsageCounts } | null;
export function absorbTranscript(state: EffortState, lines: readonly string[]): void;
export interface ClaudeAccount {
  billingType: string | null;
  organizationType: string | null;
}
export function usageSource(env: Record<string, string | undefined>, account?: ClaudeAccount | null): ModelUsageSource;
export function readClaudeAccount(env: Record<string, string | undefined>, home?: string): ClaudeAccount | null;
export function usageReport(state: EffortState, source: ModelUsageSource): ModelUsage[];
export function readNewTranscriptLines(state: EffortState, file: string): string[];
export function projectRootFor(dir: string): string;
export function stateFileFor(projectDir: string, baseDir?: string): string;
export function loadState(file: string): EffortState;
/** HH-199 — the call input with the measured effort it lacks added, or null when nothing is missing. */
export function attachEffort(state: EffortState, toolName: string, toolInput: Record<string, unknown>, now: number, source: ModelUsageSource): Record<string, unknown> | null;
/** HH-199 — why a delivering call should be repeated with the measured effort (first attempt per tool only), or null. */
export function deliveryReminder(state: EffortState, toolName: string, toolInput: Record<string, unknown>, now: number, source: ModelUsageSource): string | null;
/** HH-199 — after a work_complete: the note for measured effort that did not travel with it, or null. */
export function undeliveredNote(state: EffortState, toolInput: unknown, source: ModelUsageSource): string | null;
export function saveState(file: string, state: EffortState): void;
