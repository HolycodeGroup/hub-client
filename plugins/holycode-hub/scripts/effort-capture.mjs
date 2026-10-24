#!/usr/bin/env node
// Effort capture (HH-133) — measures human and AI time on the claimed Hub story from Claude Code
// hooks and buffers it as categorised segments for the work_* tools (HH-130 contract).
//
//   AI time    runs from a prompt submit to the agent stopping (UserPromptSubmit → Stop), and
//              pauses while the agent waits on an AskUserQuestion answer (that wait is human time);
//   human time runs from a stop to the next prompt, CAPPED at an idle threshold (away time is not
//              counted);
//   category   is the active Hub step, set from the tools the agent uses: work_claim / plan mode →
//              PLANNING, ExitPlanMode or the first edit → IMPLEMENTATION, work_verify or a
//              test/lint/typecheck command → REVIEW_GATES, project_question_add → WAITING_ON_ANSWER.
//              A step change splits the open interval.
//
// The buffer lives OUTSIDE the repository (~/.holycode-hub/effort/<hash of the project dir>.json),
// survives a restart, and holds ONLY timestamps, actor and category — never prompt text, tool input,
// code or file content. It is emptied when the claim's lease expires (the Hub refuses those
// segments) and when the story is completed or released. Hooks never block and never fail loudly.
//
// CLI: `effort-capture.mjs hook` (reads the hook event JSON on stdin) · `effort-capture.mjs take`
// (prints the pending segments as a JSON array for the work_* call; `[]` when none).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Human time per gap is capped here (away time is not counted). */
export const IDLE_CAP_MS = 15 * 60 * 1000;
/** A lease the Hub granted lasts 8 h and is renewed by every work_* call. */
export const LEASE_TTL_MS = 8 * 60 * 60 * 1000;
/** Slivers shorter than this are not worth a segment. */
export const MIN_SEGMENT_MS = 1000;

const TEST_COMMAND = /\b(test|tests|vitest|jest|playwright|pytest|lint|eslint|tsc|typecheck|go test|cargo test)\b/;

/** A fresh, story-less state. */
export function emptyState() {
  return { story: null, step: 'PLANNING', open: null, seq: 0, pending: [] };
}

const iso = (ms) => new Date(ms).toISOString();

/** Closes the open interval at `at` into a pending segment (human time capped). */
function closeOpen(state, at) {
  const open = state.open;
  state.open = null;
  if (open === null) return;
  const end = open.actor === 'HUMAN' ? Math.min(at, open.since + IDLE_CAP_MS) : at;
  if (end - open.since < MIN_SEGMENT_MS) return;
  state.seq += 1;
  state.pending.push({ seq: state.seq, actor: open.actor, category: open.category, started_at: iso(open.since), ended_at: iso(end) });
}

function openInterval(state, actor, at) {
  state.open = { actor, category: state.step, since: at };
}

/** Drops everything when the lease has expired — the Hub would refuse those segments. */
function expireIfDue(state, now) {
  if (state.story !== null && now > state.story.leaseExpiresAt) Object.assign(state, emptyState());
}

/** The category a tool use moves the step to, or null (unchanged). */
export function stepForTool(toolName, toolInput, currentStep) {
  if (/__work_claim$/.test(toolName) || toolName === 'EnterPlanMode') return 'PLANNING';
  if (/__work_verify$/.test(toolName)) return 'REVIEW_GATES';
  if (/__project_question_add$/.test(toolName)) return 'WAITING_ON_ANSWER';
  if (toolName === 'ExitPlanMode') return 'IMPLEMENTATION';
  if (toolName === 'Bash' && TEST_COMMAND.test(String(toolInput?.command ?? ''))) return 'REVIEW_GATES';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return 'IMPLEMENTATION';
  return currentStep === 'WAITING_ON_ANSWER' && toolName === 'Bash' ? 'IMPLEMENTATION' : null;
}

/** Sets the step; an open interval in another category is split at `now`. */
function setStep(state, step, now) {
  if (step === null || step === state.step) return;
  const actor = state.open?.actor ?? null;
  closeOpen(state, now);
  state.step = step;
  if (actor !== null) openInterval(state, actor, now);
}

/**
 * The claim result inside a work_claim tool response — a JSON string, the result object, an MCP
 * result (`structuredContent` / `result`) or its text content blocks.
 */
function claimPayloadOf(response) {
  const value = typeof response === 'string' ? safeJson(response) : response;
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.story?.key === 'string') return value;
  const blocks = Array.isArray(value) ? value : (value.content ?? []);
  const nested = [value.structuredContent, value.result, ...blocks.map((block) => block?.text)];
  for (const candidate of nested) {
    const payload = candidate === undefined ? null : claimPayloadOf(candidate);
    if (payload !== null) return payload;
  }
  return null;
}

/** The story key and lease expiry of a successful work_claim, or null (a refused claim has no story). */
function claimOf(toolInput, toolResponse, now) {
  const payload = claimPayloadOf(toolResponse);
  const key = payload?.story?.key ?? (/"code"|error/i.test(JSON.stringify(toolResponse ?? '')) ? null : toolInput?.story_id);
  if (typeof key !== 'string' || key === '') return null;
  const expires = Date.parse(payload?.lease?.expires_at ?? '');
  return { key, leaseExpiresAt: Number.isNaN(expires) ? now + LEASE_TTL_MS : expires };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The seqs a successful work_* call carried — they are now stored on the Hub. */
function sentSeqs(toolInput) {
  return Array.isArray(toolInput?.segments) ? new Set(toolInput.segments.map((s) => s?.seq)) : new Set();
}

/**
 * Applies one Claude Code hook event to the state. Pure apart from the clock value passed in.
 *
 * @param {ReturnType<typeof emptyState>} state - mutated in place.
 * @param {{hook_event_name: string, tool_name?: string, tool_input?: any, tool_response?: any}} event
 * @param {number} now - epoch ms.
 */
export function applyEvent(state, event, now) {
  expireIfDue(state, now);
  const name = event.hook_event_name;
  const tool = String(event.tool_name ?? '');
  if (name === 'PostToolUse' && /__work_claim$/.test(tool)) {
    const claim = claimOf(event.tool_input, event.tool_response, now);
    if (claim !== null && claim.key !== state.story?.key) {
      Object.assign(state, emptyState(), { seq: state.seq });
      state.story = claim;
      openInterval(state, 'AI', now); // the claim happens inside an agent turn
      return;
    }
  }
  if (state.story === null) return;
  if (name === 'UserPromptSubmit') {
    closeOpen(state, now);
    openInterval(state, 'AI', now);
  } else if (name === 'Stop') {
    closeOpen(state, now);
    openInterval(state, 'HUMAN', now);
  } else if (name === 'SessionEnd') {
    closeOpen(state, now);
  } else if (name === 'PreToolUse' && tool === 'AskUserQuestion') {
    closeOpen(state, now);
    openInterval(state, 'HUMAN', now);
  } else if (name === 'PostToolUse') {
    if (tool === 'AskUserQuestion') {
      closeOpen(state, now);
      openInterval(state, 'AI', now);
    }
    applyWorkCall(state, tool, event.tool_input, now);
    setStep(state, stepForTool(tool, event.tool_input, state.step), now);
  }
}

/** A successful work_* call: drop what it sent, renew the lease view, end on complete/release. */
function applyWorkCall(state, tool, toolInput, now) {
  if (!/__work_(progress|verify|complete|release)$/.test(tool)) return;
  const sent = sentSeqs(toolInput);
  state.pending = state.pending.filter((s) => !sent.has(s.seq));
  if (/__work_(complete|release)$/.test(tool)) {
    Object.assign(state, emptyState(), { seq: state.seq });
    return;
  }
  state.story.leaseExpiresAt = now + LEASE_TTL_MS;
}

/** The segments to send now: the open interval is cut at `now` (and keeps running). */
export function take(state, now) {
  expireIfDue(state, now);
  if (state.open !== null) {
    const actor = state.open.actor;
    closeOpen(state, now);
    openInterval(state, actor, now);
  }
  return state.pending;
}

// ---- persistence + CLI (thin) ------------------------------------------------------------------

/**
 * The linked project's root for a directory: the nearest ancestor holding the Hub pointer file, so a
 * hook (session cwd) and `take` (run from wherever the shell is) resolve to the same buffer.
 */
export function projectRootFor(dir) {
  let current = realpathSync(path.resolve(dir));
  for (;;) {
    if (existsSync(path.join(current, '.project-management', 'hub-pointer.md'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return realpathSync(path.resolve(dir));
    current = parent;
  }
}

/** The state file for a project directory (outside the repository). */
export function stateFileFor(projectDir, baseDir = process.env.HOLYCODE_EFFORT_DIR ?? path.join(homedir(), '.holycode-hub', 'effort')) {
  const hash = createHash('sha256').update(projectRootFor(projectDir)).digest('hex').slice(0, 16);
  return path.join(baseDir, `${hash}.json`);
}

export function loadState(file) {
  const parsed = safeJson(readOr(file));
  return parsed !== null && typeof parsed === 'object' ? { ...emptyState(), ...parsed } : emptyState();
}

function readOr(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

function main(argv, stdin, now) {
  const command = argv[0];
  if (command === 'hook') {
    const event = safeJson(stdin) ?? {};
    const file = stateFileFor(event.cwd ?? process.cwd());
    const state = loadState(file);
    applyEvent(state, event, now);
    saveState(file, state);
    return '';
  }
  if (command === 'take') {
    const file = stateFileFor(process.cwd());
    const state = loadState(file);
    const segments = take(state, now);
    saveState(file, state);
    return JSON.stringify(segments);
  }
  return '';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Hooks must never block a session: any failure is swallowed (exit 0, nothing printed).
  try {
    const stdin = process.argv[2] === 'hook' ? readFileSync(0, 'utf8') : '';
    process.stdout.write(main(process.argv.slice(2), stdin, Date.now()));
  } catch {
    if (process.argv[2] === 'take') process.stdout.write('[]');
  }
}
