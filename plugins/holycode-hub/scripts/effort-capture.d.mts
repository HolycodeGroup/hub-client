// Types for scripts/effort-capture.mjs (HH-133), consumed by its tests.
export type EffortActor = 'HUMAN' | 'AI';
export type EffortCategory = 'PLANNING' | 'IMPLEMENTATION' | 'REVIEW_GATES' | 'WAITING_ON_ANSWER' | 'OTHER';
export type EffortSegment = { seq: number; actor: EffortActor; category: EffortCategory; started_at: string; ended_at: string };
export type EffortState = {
  story: { key: string; leaseExpiresAt: number } | null;
  step: EffortCategory;
  open: { actor: EffortActor; category: EffortCategory; since: number } | null;
  seq: number;
  pending: EffortSegment[];
};
export type HookEvent = { hook_event_name: string; cwd?: string; tool_name?: string; tool_input?: unknown; tool_response?: unknown };

export const IDLE_CAP_MS: number;
export const LEASE_TTL_MS: number;
export const MIN_SEGMENT_MS: number;
export function emptyState(): EffortState;
export function stepForTool(toolName: string, toolInput: unknown, currentStep: EffortCategory): EffortCategory | null;
export function applyEvent(state: EffortState, event: HookEvent, now: number): void;
export function take(state: EffortState, now: number): EffortSegment[];
export function projectRootFor(dir: string): string;
export function stateFileFor(projectDir: string, baseDir?: string): string;
export function loadState(file: string): EffortState;
export function saveState(file: string, state: EffortState): void;
