#!/usr/bin/env node
// Effort capture (HH-133) — measures human and AI time on the claimed Hub story from Claude Code
// hooks and buffers it as categorised segments for the work_* tools (HH-130 contract).
//
//   AI time    runs from a prompt submit to the agent stopping (UserPromptSubmit → Stop), and
//              pauses while the agent waits on an AskUserQuestion answer (that wait is human time);
//   human time runs from a stop to the next prompt, CAPPED at an idle threshold (away time is not
//              counted);
//   category   is the active Hub step, set from the tools the agent uses: work_claim / plan mode →
//              PLANNING, ExitPlanMode or the first edit → IMPLEMENTATION, work_verify or a command
//              that RUNS tests / lint / typecheck / audit → REVIEW_GATES (HH-292: the executed runner
//              or package script, in each segment of a chain — never a word in a path or argument),
//              project_question_add → WAITING_ON_ANSWER. A step change splits the open interval.
//
// Background work (HH-292): a Bash command or agent started with run_in_background is still working
// after the agent stops, so that stop opens AI time, not human time, up to BACKGROUND_CAP_MS after the
// latest one started. The agent turn that follows without a user prompt (a task notification) is one
// of them reporting back; a real user prompt ends them all, and an unreported one is forgotten after
// the cap. The buffer holds only their start times.
//
// The buffer lives OUTSIDE the repository (~/.holycode-hub/effort/<hash of the project dir>.json),
// survives a restart, and holds ONLY timestamps, actor and category — never prompt text, tool input,
// code or file content. It is emptied when the claim's lease expires (the Hub refuses those
// segments) and when the story is completed or released. Hooks never block and never fail loudly.
//
// Model usage (HH-171): at each Stop and session end, and before a usage report, the NEW lines of
// the session transcript are read (from a stored byte offset) and each assistant message's model
// and token counts after the claim are kept — keyed by message id, so a message streamed over
// several lines counts once (its last line wins). The buffer then holds only the model id and four
// counts per message, never the message text. The report is the attempt's CUMULATIVE totals per
// model (the Hub keeps the larger value, so sending it again is harmless); it is emptied with the
// segments. A transcript that cannot be read is skipped silently.
//
// Delivery (HH-199): the measured effort no longer depends on whoever calls the Hub remembering the
// `take` / `usage` steps. A PreToolUse hook on work_progress / work_verify / work_complete for the
// claimed story checks the call: when it lacks pending segments or the model usage, the hook refuses
// it ONCE with the exact fields to add (a documented deny; it never approves or widens a permission),
// and the agent repeats the call with them; a human_ms / ai_ms estimate goes when measured segments
// go along. A second attempt is never refused, so nothing loops. After a work_complete, a PostToolUse
// hook says so visibly when measured effort still did not travel with it (the Hub accepts it only up
// to completion) instead of losing it silently. Counts and timestamps only, as before.
//
// Several stories (HH-290): the buffer measures ONE active story at a time and PARKS every other story
// it holds (`held`, keyed by story key) with its pending segments and usage — nothing is ever dropped
// because another story was claimed. A claim of a NEW story parks the active one and makes the new one
// active; a claim of a story already held (a standing order's re-read, which only renews its lease)
// switches nothing. Work on a held story's worktree (a tool input naming `.worktrees/<key>/`) makes it
// the active story. The stories a standing order hands out are held from its claim on. A work_* call
// delivers the effort of the story it names — active or parked — and never another story's segments.
//
// Effort from another clone (HH-681): each clone or computer keeps its own buffer, so when a story is
// completed from one, the other still holds that story's measured time. When a story's lease view runs
// out here, its pending segments and usage are kept as UNSENT (`unsent`, by story key) for
// UNSENT_KEEP_MS instead of being dropped. At session start the hook hands the agent one work_progress
// call per story with pending effort — unsent, held or active — to make quietly (Claude Code hooks
// cannot call the Hub themselves, so the call is the agent's; it shows nothing unless it fails). The
// Hub accepts it from the story's completer for 7 days and merges it by time, so a repeat is harmless.
// A sent story leaves `unsent`; a refusal (another person's story, past the window, a bad segment)
// drops it quietly, and so does the third failed attempt; "not completed yet" (FORBIDDEN_CLAIM) keeps
// it for a later session start. A new claim of an unsent story takes its
// time back into the story.
//
// CLI: `effort-capture.mjs hook` (reads the hook event JSON on stdin) · `effort-capture.mjs take`
// (prints the pending segments as a JSON array for the work_* call; `[]` when none) ·
// `effort-capture.mjs usage` (prints the model usage as a JSON array for `model_usage`; `[]` when none).
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** The largest count the Hub accepts per counter (HH-170), and the most models per report. */
export const USAGE_COUNT_MAX = 2_000_000_000;
export const USAGE_MODELS_MAX = 20;
/** At most this many new transcript bytes are read per hook run — the rest waits for the next one. */
export const TRANSCRIPT_READ_MAX_BYTES = 32 * 1024 * 1024;
/** A model id the Hub accepts (HH-170); anything else (e.g. "<synthetic>") is not a model call. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;

/** HH-681 — unsent effort of a story whose lease view ran out is kept this long for a session-start send. */
export const UNSENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** HH-681 — an unsent story is dropped after this many failed sends (a refusal drops it at once). */
export const UNSENT_FAILURES_MAX = 3;
/** HH-681 — the most segments one work_progress call carries (the Hub's batch limit). */
export const SEND_SEGMENTS_MAX = 200;

/** Background work (HH-292) counts as AI time after a stop for at most this long, and is forgotten after it. */
export const BACKGROUND_CAP_MS = 30 * 60 * 1000;
/** At most this many outstanding background tasks are remembered. */
const BACKGROUND_MAX = 20;

/** A package script that runs checks: `test`, `test:coverage`, `lint`, `typecheck`, `audit`, … */
const CHECK_SCRIPT = /^(test|tests|lint|typecheck|type-check|check-types|audit)(:[\w:.-]+)?$/;
/** A runner binary that runs checks on its own, or with the named sub-command. */
const CHECK_BINARY = new Set(['vitest', 'jest', 'mocha', 'pytest', 'eslint']);
const CHECK_SUBCOMMAND = new Set(['playwright test', 'go test', 'go vet', 'cargo test', 'cargo clippy', 'flutter test', 'flutter analyze', 'dart analyze']);
/** Package runners whose next word is a script or a binary; their flags that take a value. */
const PACKAGE_RUNNER = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'turbo']);
const RUNNER_VERB = new Set(['run', 'exec', 'dlx', 'x', 'run-script']);
const RUNNER_VALUE_FLAG = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--workspace']);
/** Words that only wrap the command they precede. */
const WRAPPER = new Set(['env', 'time', 'nice', 'nohup', 'sudo', 'exec', 'command', 'timeout']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A fresh, story-less state. */
export function emptyState() {
  return { story: null, step: 'PLANNING', open: null, seq: 0, pending: [], usage: emptyUsage(), reminded: {}, held: {}, background: [], unsent: {} };
}

/** The active story ends: its fields reset; the seq counter, the parked stories and the transcript offsets stay. */
function clearActive(state) {
  Object.assign(state, { story: null, step: 'PLANNING', open: null, pending: [], reminded: {} });
  state.usage.messages = {};
}

/** No usage yet: per message id `[model, input, output, cacheCreation, cacheRead]`; read offsets per transcript. */
function emptyUsage() {
  return { messages: {}, transcripts: {}, transcript: null };
}

const iso = (ms) => new Date(ms).toISOString();

/** Closes the open interval at `at` into a pending segment (human time and background AI time capped). */
function closeOpen(state, at) {
  const open = state.open;
  state.open = null;
  if (open === null) return;
  const end = open.actor === 'HUMAN' ? Math.min(at, open.since + IDLE_CAP_MS) : Math.min(at, open.until ?? at);
  if (end - open.since < MIN_SEGMENT_MS) return;
  state.seq += 1;
  state.pending.push({ seq: state.seq, actor: open.actor, category: open.category, started_at: iso(open.since), ended_at: iso(end) });
}

/** Opens an interval; `until` marks AI time that runs only while background work does (HH-292). */
function openInterval(state, actor, at, until) {
  state.open = until === undefined ? { actor, category: state.step, since: at } : { actor, category: state.step, since: at, until };
}

/**
 * Ends each story whose lease view has run out, active or parked: its pending effort is kept as unsent
 * (HH-681 — the story may have been completed from another clone, and the Hub accepts its completer's
 * late effort); unsent effort older than UNSENT_KEEP_MS is dropped.
 */
function expireIfDue(state, now) {
  state.held = state.held ?? {};
  state.unsent = state.unsent ?? {};
  for (const [key, slot] of Object.entries(state.held)) {
    if (now <= slot.story.leaseExpiresAt) continue;
    keepUnsent(state, slot.story, slot.pending, slot.messages, now);
    delete state.held[key];
  }
  if (state.story !== null && now > state.story.leaseExpiresAt) {
    keepUnsent(state, state.story, state.pending, state.usage.messages, now);
    clearActive(state);
  }
  for (const [key, slot] of Object.entries(state.unsent)) if (now - slot.since > UNSENT_KEEP_MS) delete state.unsent[key];
  state.background = (state.background ?? []).filter((startedAt) => now - startedAt <= BACKGROUND_CAP_MS);
}

// ---- effort from another clone (HH-681) ---------------------------------------------------------

/** Keeps a story's pending segments and usage as unsent (merged with any already kept). */
function keepUnsent(state, story, pending, messages, now) {
  if (pending.length === 0 && Object.keys(messages ?? {}).length === 0) return;
  const prior = state.unsent[story.key];
  state.unsent[story.key] = {
    story: { key: story.key, id: story.id ?? prior?.story.id ?? null },
    pending: [...(prior?.pending ?? []), ...pending],
    messages: { ...(prior?.messages ?? {}), ...messages },
    since: prior?.since ?? now, // the keep runs from the FIRST time the story became unsent
    failures: 0,
  };
}

/** Takes a story's unsent effort back into the slot that measures it again (a new claim of it). */
function reclaimUnsent(state, key, slot) {
  const unsent = state.unsent?.[key];
  if (unsent === undefined) return;
  slot.pending.push(...unsent.pending);
  Object.assign(slot.messages, unsent.messages);
  delete state.unsent[key];
}

/** The unsent story a work_* call names (by key or id), or null. */
function unsentNamed(state, toolInput) {
  const named = toolInput?.story_id;
  if (typeof named !== 'string') return null;
  return Object.keys(state.unsent ?? {}).find((key) => key === named || state.unsent[key].story.id === named) ?? null;
}

/** A response the Hub refused for good: a typed refusal or its wording — sending it again cannot help. */
function refusedForGood(response) {
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return /(FORBIDDEN|VALIDATION|CONFLICT|NOT_FOUND)_[A-Z_]+|accepted only from the person who completed it|No live claim|Resource not accessible|segments\[\d+\]/.test(text);
}

/** The story is not completed yet (no lease, no completion) or held by someone: worth asking again later. */
function notCompletedYet(response) {
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return /FORBIDDEN_CLAIM|No live claim|CONFLICT_CLAIM_HELD/.test(text);
}

/**
 * A work_progress for an unsent story finished: what it carried is sent; a refusal drops the story —
 * except "not completed yet" (the other clone may still complete it), which keeps it for a later
 * session start until UNSENT_KEEP_MS runs out.
 */
function applyUnsentSend(state, key, event) {
  const slot = state.unsent[key];
  if (event.tool_failed === true && notCompletedYet(event.tool_response)) return;
  if (event.tool_failed === true) {
    slot.failures = (slot.failures ?? 0) + 1;
    if (refusedForGood(event.tool_response) || slot.failures >= UNSENT_FAILURES_MAX) delete state.unsent[key];
    return;
  }
  const sent = sentSeqs(event.tool_input);
  slot.pending = slot.pending.filter((s) => !sent.has(s.seq));
  if (Array.isArray(event.tool_input?.model_usage) && event.tool_input.model_usage.length > 0) slot.messages = {};
  if (slot.pending.length === 0 && Object.keys(slot.messages).length === 0) delete state.unsent[key];
}

/**
 * The work_progress calls to make at session start (HH-681): one per story with pending effort — the
 * active and held stories' pending segments, and each unsent story's segments and usage. Each input
 * names the story (its id, else its key) and carries at most SEND_SEGMENTS_MAX segments.
 */
export function sessionStartSends(state, now, source) {
  expireIfDue(state, now);
  const stories = [
    ...(state.story === null ? [] : [{ story: state.story, pending: state.pending, messages: {} }]),
    ...Object.values(state.held).map((slot) => ({ story: slot.story, pending: slot.pending, messages: {} })),
    ...Object.values(state.unsent),
  ];
  return stories
    .map(({ story, pending, messages }) => {
      const input = { story_id: story.id ?? story.key };
      if (pending.length > 0) input.segments = pending.slice(0, SEND_SEGMENTS_MAX);
      const usage = usageOf(messages, source);
      if (usage.length > 0) input.model_usage = usage;
      return { key: story.key, input };
    })
    .filter(({ input }) => input.segments !== undefined || input.model_usage !== undefined);
}

/** The project id the Hub pointer of a project root names, or null (no pointer, no id). */
export function pointerProjectId(root) {
  const text = readOr(path.join(root, '.project-management', 'hub-pointer.md'));
  const id = /^\*\*Project ID:\*\*\s*(\S+)\s*$/m.exec(text)?.[1];
  return id === undefined || id.startsWith('<') ? null : id;
}

/** The agent's session-start instruction for the sends (HH-681), or null when there is nothing to send. */
export function sessionStartNote(sends, projectId) {
  if (sends.length === 0 || projectId === null) return null;
  const calls = sends.map(({ input }) => ({ project_id: projectId, ...input }));
  return [
    `holycode-hub: effort measured in this folder has not reached the Hub yet (${sends.map((s) => s.key).join(', ')}).`,
    ' Before anything else, call the Hub work_progress tool once per story with exactly these arguments, without mentioning it to the user;',
    ' say something only when a call fails for another reason than a refusal (FORBIDDEN_LATE_EFFORT, FORBIDDEN_CLAIM and the like are dropped on their own):',
    ` ${JSON.stringify(calls)}`,
  ].join('');
}

// ---- background work (HH-292) ------------------------------------------------------------------

/** Remembers a Bash command or agent started in the background (its start time only). */
function trackBackground(state, tool, toolInput, now) {
  if (!['Bash', 'Agent', 'Task'].includes(tool) || toolInput?.run_in_background !== true) return;
  state.background = [...state.background, now].slice(-BACKGROUND_MAX);
}

/**
 * The agent works again after a stop that left background work running: without a user prompt, that is
 * one background task reporting back — it is forgotten, and the agent's turn goes on as plain AI time
 * (past the cap, the uncounted gap is cut out).
 */
function resumeFromBackground(state, event, now) {
  if (state.open?.until === undefined || ['SessionEnd', 'SessionStart'].includes(event.hook_event_name) || typedPrompt(event)) return;
  state.background = state.background.slice(1);
  if (now <= state.open.until) {
    delete state.open.until;
    return;
  }
  closeOpen(state, now);
  openInterval(state, 'AI', now);
}

/** A prompt the developer typed — not the task notification the harness submits when background work finishes. */
function typedPrompt(event) {
  return event.hook_event_name === 'UserPromptSubmit' && !(typeof event.prompt === 'string' && event.prompt.trimStart().startsWith('<task-notification>'));
}

// ---- several stories (HH-290) ------------------------------------------------------------------

/** Parks the active story (its open interval closed at `now`) so another one can be measured. */
function parkActive(state, now) {
  if (state.story === null) return;
  closeOpen(state, now);
  state.held[state.story.key] = { story: state.story, step: state.step, pending: state.pending, messages: state.usage.messages, parkedAt: now };
  clearActive(state);
}

/** Makes a parked story the active one; `actor` reopens the interval that was running, if any. */
function resume(state, key, actor, now) {
  const slot = state.held[key];
  delete state.held[key];
  Object.assign(state, { story: slot.story, step: slot.step, pending: slot.pending, open: null, reminded: {} });
  state.usage.messages = slot.messages;
  if (actor !== null) openInterval(state, actor, now);
}

/** Switches measurement to the parked story `key`, keeping the running actor. */
function switchTo(state, key, now) {
  const actor = state.open?.actor ?? null;
  parkActive(state, now);
  resume(state, key, actor, now);
}

/** After the active story ended: the most recently parked story (if any) becomes the active one. */
function resumeLatest(state, actor, now) {
  const latest = Object.entries(state.held).sort(([, a], [, b]) => b.parkedAt - a.parkedAt)[0];
  if (latest !== undefined) resume(state, latest[0], actor, now);
}

/** Parks a story a standing order handed out, unless it is already held. */
function holdHandedOut(state, entry, claim) {
  if (typeof entry?.key !== 'string' || entry.key === claim.key || entry.key === state.story?.key || state.held[entry.key] !== undefined) return;
  const story = { key: entry.key, id: typeof entry.id === 'string' ? entry.id : null, leaseExpiresAt: claim.leaseExpiresAt, claimedAt: claim.claimedAt };
  state.held[entry.key] = { story, step: 'PLANNING', pending: [], messages: {}, parkedAt: claim.claimedAt };
}

const WORKTREE_KEY = /\.worktrees\/([A-Za-z][A-Za-z0-9]*-\d+)(?=[/\s"'`]|$)/g;

/** The parked story whose worktree a tool input names (its paths or command), or null. */
export function worktreeStoryOf(state, toolInput) {
  const text = [toolInput?.file_path, toolInput?.notebook_path, toolInput?.path, toolInput?.command].filter((v) => typeof v === 'string').join('\n');
  const parked = new Map(Object.keys(state.held ?? {}).map((key) => [key.toLowerCase(), key]));
  for (const [, name] of text.matchAll(WORKTREE_KEY)) {
    const key = parked.get(name.toLowerCase());
    if (key !== undefined) return key;
  }
  return null;
}

/** The parked story a work_* call names (by key or id), or null. */
function heldNamed(state, toolInput) {
  const named = toolInput?.story_id;
  if (typeof named !== 'string') return null;
  return Object.keys(state.held ?? {}).find((key) => key === named || state.held[key].story.id === named) ?? null;
}

/** The category a tool use moves the step to, or null (unchanged). */
export function stepForTool(toolName, toolInput, currentStep) {
  if (/__work_claim$/.test(toolName) || toolName === 'EnterPlanMode') return 'PLANNING';
  if (/__work_verify$/.test(toolName)) return 'REVIEW_GATES';
  if (/__project_question_add$/.test(toolName)) return 'WAITING_ON_ANSWER';
  if (toolName === 'ExitPlanMode') return 'IMPLEMENTATION';
  if (toolName === 'Bash' && runsChecks(String(toolInput?.command ?? ''))) return 'REVIEW_GATES';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return 'IMPLEMENTATION';
  return currentStep === 'WAITING_ON_ANSWER' && toolName === 'Bash' ? 'IMPLEMENTATION' : null;
}

/**
 * Whether a shell command RUNS tests / lint / typecheck / audit (HH-292): some segment of its `&&` /
 * `;` / `|` chain executes a check runner or a check package script — after any `cd` / `source`
 * segment, env assignments and wrappers. A word in a path or argument (`cat a.test.ts`) never counts.
 */
export function runsChecks(command) {
  return command.split(/[;&|\n]+/).some((segment) => runsCheck(segment.replace(/[(){}]/g, ' ').split(/\s+/).filter(Boolean)));
}

/** Whether one simple command (its words) runs a check. */
function runsCheck(words) {
  let i = 0;
  while (i < words.length && (ENV_ASSIGNMENT.test(words[i]) || WRAPPER.has(words[i]) || /^\d+[smhd]?$/.test(words[i]))) i += 1;
  const binary = path.basename(words[i] ?? '');
  if (PACKAGE_RUNNER.has(binary)) {
    const script = scriptWords(words.slice(i + 1));
    return CHECK_SCRIPT.test(script[0] ?? '') || runsCheck(script);
  }
  if (binary === 'tsc') return words.includes('--noEmit');
  return CHECK_BINARY.has(binary) || CHECK_SUBCOMMAND.has(`${binary} ${words[i + 1]}`);
}

/** The words after a package runner, from the script or binary it runs (flags and `run` / `exec` skipped). */
function scriptWords(words) {
  let i = 0;
  while (i < words.length && (words[i].startsWith('-') || RUNNER_VERB.has(words[i]))) i += RUNNER_VALUE_FLAG.has(words[i]) ? 2 : 1;
  return words.slice(i);
}

/** Sets the step; an open interval in another category is split at `now`. */
function setStep(state, step, now) {
  if (step === null || step === state.step) return;
  const open = state.open;
  closeOpen(state, now);
  state.step = step;
  if (open !== null) openInterval(state, open.actor, now, open.until);
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
  const id = typeof payload?.story?.id === 'string' ? payload.story.id : null;
  const handedOut = Array.isArray(payload?.standing_order?.handed_out) ? payload.standing_order.handed_out : [];
  return { key, id, leaseExpiresAt: Number.isNaN(expires) ? now + LEASE_TTL_MS : expires, claimedAt: now, handedOut };
}

/**
 * A successful work_claim (HH-290): a new story parks the active one and becomes active; a story
 * already held only has its lease view renewed; a standing order's other stories are held from now on.
 */
function applyClaim(state, claim, now) {
  const { handedOut, ...story } = claim;
  if (story.key === state.story?.key) {
    state.story.leaseExpiresAt = story.leaseExpiresAt;
  } else if (state.held[story.key] !== undefined) {
    state.held[story.key].story.leaseExpiresAt = story.leaseExpiresAt;
    reclaimUnsent(state, story.key, state.held[story.key]);
  } else {
    parkActive(state, now);
    state.story = story;
    reclaimUnsent(state, story.key, { pending: state.pending, messages: state.usage.messages });
    openInterval(state, 'AI', now); // the claim happens inside an agent turn
  }
  for (const entry of handedOut) holdHandedOut(state, entry, claim);
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
  if (typeof event.transcript_path === 'string') state.usage.transcript = event.transcript_path;
  const name = event.hook_event_name;
  const tool = String(event.tool_name ?? '');
  resumeFromBackground(state, event, now);
  if (name === 'PostToolUse' && /__work_claim$/.test(tool) && event.tool_failed !== true) {
    const claim = claimOf(event.tool_input, event.tool_response, now);
    if (claim !== null) {
      applyClaim(state, claim, now);
      return;
    }
  }
  // HH-681 — the session-start send of a story's unsent effort (a story no longer measured here).
  if (name === 'PostToolUse' && /__work_progress$/.test(tool) && !namesClaimedStory(state, event.tool_input) && heldNamed(state, event.tool_input) === null) {
    const unsent = unsentNamed(state, event.tool_input);
    if (unsent !== null) {
      applyUnsentSend(state, unsent, event);
      return;
    }
  }
  if (name === 'PostToolUse' && event.tool_failed !== true && heldNamed(state, event.tool_input) !== null && /__work_/.test(tool)) {
    applyWorkCall(state, tool, event.tool_input, now);
    return;
  }
  if (name === 'PostToolUse') {
    const worktree = worktreeStoryOf(state, event.tool_input);
    if (worktree !== null) switchTo(state, worktree, now);
  }
  if (state.story === null) return;
  if (typedPrompt(event)) {
    closeOpen(state, now);
    state.background = [];
    openInterval(state, 'AI', now);
  } else if (name === 'UserPromptSubmit') {
    if (state.open?.actor !== 'AI') {
      closeOpen(state, now);
      openInterval(state, 'AI', now);
    }
  } else if (name === 'Stop') {
    closeOpen(state, now);
    // HH-292 — background work the agent started is still running: the stop is not human time yet.
    if (state.background.length > 0) openInterval(state, 'AI', now, Math.max(...state.background) + BACKGROUND_CAP_MS);
    else openInterval(state, 'HUMAN', now);
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
    // HH-199 — a call the Hub refused delivered nothing: the buffer stays for the retry.
    if (event.tool_failed !== true) applyWorkCall(state, tool, event.tool_input, now);
    trackBackground(state, tool, event.tool_input, now);
    setStep(state, stepForTool(tool, event.tool_input, state.step), now);
  }
}

/**
 * A successful work_* call: drop what it sent, renew the lease view, end on complete/release — on the
 * parked story it names (HH-290), else on the active one. When the active story ends, the most recently
 * parked story becomes active.
 */
function applyWorkCall(state, tool, toolInput, now) {
  if (!/__work_(progress|verify|complete|release)$/.test(tool)) return;
  const sent = sentSeqs(toolInput);
  const ends = /__work_(complete|release)$/.test(tool);
  const parked = heldNamed(state, toolInput);
  if (parked !== null) {
    const slot = state.held[parked];
    if (ends) delete state.held[parked];
    else {
      slot.pending = slot.pending.filter((s) => !sent.has(s.seq));
      slot.story.leaseExpiresAt = now + LEASE_TTL_MS;
    }
    return;
  }
  state.pending = state.pending.filter((s) => !sent.has(s.seq));
  state.reminded = {};
  if (ends) {
    const actor = state.open?.actor ?? null;
    clearActive(state);
    resumeLatest(state, actor, now);
    return;
  }
  state.story.leaseExpiresAt = now + LEASE_TTL_MS;
}

/** The segments to send now: the open interval is cut at `now` (and keeps running). */
export function take(state, now) {
  expireIfDue(state, now);
  if (state.open !== null) {
    const { actor, until } = state.open;
    closeOpen(state, now);
    openInterval(state, actor, now, until);
  }
  return state.pending;
}

// ---- delivery (HH-199) -------------------------------------------------------------------------

/** The work_* calls that carry measured effort to the Hub. */
const DELIVERING_TOOL = /__work_(progress|verify|complete)$/;

/** Whether a work_* call names the claimed story (by key or by id). */
function namesClaimedStory(state, toolInput) {
  const named = toolInput?.story_id;
  return state.story !== null && typeof named === 'string' && (named === state.story.key || named === state.story.id);
}

/**
 * The measured effort of the story a work_* call names (HH-290): the active story's (its open interval
 * cut at `now`) or a parked one's — or null when the call names neither.
 */
function namedEffort(state, toolInput, now) {
  if (namesClaimedStory(state, toolInput)) return { key: state.story.key, segments: take(state, now), messages: state.usage.messages };
  const parked = heldNamed(state, toolInput);
  if (parked === null) return null;
  const slot = state.held[parked];
  return { key: parked, segments: slot.pending, messages: slot.messages };
}

/** The seqs pending on every story but `key` — segments a call for `key` must never carry. */
function otherStoriesSeqs(state, key) {
  const pending = [...(state.story !== null && state.story.key !== key ? state.pending : [])];
  for (const [held, slot] of Object.entries(state.held ?? {})) if (held !== key) pending.push(...slot.pending);
  return new Set(pending.map((s) => s.seq));
}

/**
 * The input a delivering work_* call should carry: the caller's own input plus the pending segments it
 * lacks (by seq) and, for verify / complete, the model usage when it carries none — of the story the
 * call names, active or parked; segments measured on another story are taken out (HH-290). When
 * measured segments go along, a human_ms / ai_ms estimate is dropped — measured time wins. Null when
 * there is nothing to change (another tool, an unknown story, nothing measured), so the call runs untouched.
 */
export function attachEffort(state, toolName, toolInput, now, source) {
  if (!DELIVERING_TOOL.test(toolName)) return null;
  const effort = namedEffort(state, toolInput, now);
  if (effort === null) return null;
  const others = otherStoriesSeqs(state, effort.key);
  const carried = Array.isArray(toolInput.segments) ? toolInput.segments : [];
  const own = carried.filter((segment) => !others.has(segment?.seq));
  const sent = new Set(own.map((segment) => segment?.seq));
  const segments = effort.segments.filter((segment) => !sent.has(segment.seq));
  const usage = /__work_progress$/.test(toolName) || Array.isArray(toolInput.model_usage) ? [] : usageOf(effort.messages, source);
  const foreign = own.length < carried.length;
  if (segments.length === 0 && usage.length === 0 && !foreign) return null;
  const next = { ...toolInput };
  if (foreign) next.segments = own;
  if (segments.length > 0) {
    next.segments = [...own, ...segments];
    delete next.human_ms;
    delete next.ai_ms;
  }
  if (usage.length > 0) next.model_usage = usage;
  return next;
}

/** The key of the story a work_* call names, active or parked, or null. */
function namedKey(state, toolInput) {
  return namesClaimedStory(state, toolInput) ? state.story.key : heldNamed(state, toolInput);
}

/**
 * Why a delivering call should be repeated with the measured effort, naming the exact fields to add —
 * or null to let it run. Only the first attempt per tool is refused (`state.reminded`, reset by a
 * successful work_* call), so a call that cannot carry them still goes through.
 */
export function deliveryReminder(state, toolName, toolInput, now, source) {
  const next = attachEffort(state, toolName, toolInput, now, source);
  if (next === null) return null;
  state.reminded = state.reminded ?? {};
  if (state.reminded[toolName] === true) return null;
  state.reminded[toolName] = true;
  const add = {};
  if (next.segments !== toolInput.segments) add.segments = next.segments;
  if (next.model_usage !== toolInput.model_usage) add.model_usage = next.model_usage;
  const drop = ['human_ms', 'ai_ms'].filter((field) => field in toolInput && !(field in next));
  const key = namedKey(state, toolInput);
  const others = otherStoriesSeqs(state, key);
  const foreign = Array.isArray(toolInput.segments) && toolInput.segments.some((segment) => others.has(segment?.seq));
  return [
    foreign
      ? `holycode-hub: this call carries effort measured on another story, not ${key}. Call it again with segments replaced by`
      : `holycode-hub: this call leaves out the effort measured on ${key}. Call it again with these fields added`,
    drop.length > 0 ? ` and without ${drop.join(' / ')}` : '',
    ` (counts and timestamps only): ${JSON.stringify(add)}`,
  ].join('');
}

/**
 * After a work_complete: what was measured but did not travel with it (the Hub accepts effort only up
 * to completion), as a short note for the developer — or null when everything went along.
 */
export function undeliveredNote(state, toolInput, source) {
  const key = namedKey(state, toolInput);
  if (key === null) return null;
  const parked = key === state.story?.key ? null : state.held[key];
  const sent = sentSeqs(toolInput);
  const segments = (parked?.pending ?? state.pending).filter((segment) => !sent.has(segment.seq)).length;
  const usage = Array.isArray(toolInput?.model_usage) && toolInput.model_usage.length > 0 ? 0 : usageOf(parked?.messages ?? state.usage.messages, source).length;
  if (segments === 0 && usage === 0) return null;
  const what = [segments > 0 ? `${segments} measured time segment${segments === 1 ? '' : 's'}` : null, usage > 0 ? 'the token counts' : null].filter(Boolean).join(' and ');
  return `holycode-hub: ${key} was completed without ${what}; the Hub accepts them only up to completion, so they are not recorded.`;
}

// ---- model usage (HH-171) ----------------------------------------------------------------------

const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

/**
 * One transcript line's usage — `{ id, counts: [model, input, output, cacheCreation, cacheRead] }`
 * for an assistant message at or after `since` — or null. Only these fields are read.
 */
export function usageOfLine(line, since) {
  const entry = safeJson(line);
  const message = entry?.message;
  if (entry?.type !== 'assistant' || message === null || typeof message !== 'object') return null;
  const at = Date.parse(entry.timestamp ?? '');
  if (Number.isNaN(at) || at < since) return null;
  const { id, model, usage } = message;
  if (typeof id !== 'string' || typeof model !== 'string' || !MODEL_ID.test(model) || usage === null || typeof usage !== 'object') return null;
  return {
    id,
    counts: [model, count(usage.input_tokens), count(usage.output_tokens), count(usage.cache_creation_input_tokens), count(usage.cache_read_input_tokens)],
  };
}

/** Keeps the usage of each assistant message in `lines` after the claim (the last line of a message wins). */
export function absorbTranscript(state, lines) {
  if (state.story === null) return;
  for (const line of lines) {
    const usage = usageOfLine(line, state.story.claimedAt ?? 0);
    if (usage !== null) state.usage.messages[usage.id] = usage.counts;
  }
}

const isSet = (value) => typeof value === 'string' && value.trim() !== '';
const isOn = (value) => isSet(value) && !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());

/**
 * HH-396 — how the member pays for the model, from the same settings Claude Code itself reads: a cloud
 * provider flag (Bedrock, Vertex, Foundry), a gateway (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`),
 * an API key, else the signed-in account Claude Code recorded — a claude.ai subscription is SUBSCRIPTION,
 * any other signed-in account (a Console login) is billed per token. Nothing known → UNKNOWN, never a guess.
 * `account` is Claude Code's `oauthAccount` record (only `billingType` and `organizationType` are read).
 */
export function usageSource(env, account = null) {
  if (isOn(env.CLAUDE_CODE_USE_BEDROCK)) return 'BEDROCK';
  if (isOn(env.CLAUDE_CODE_USE_VERTEX)) return 'VERTEX';
  if (isOn(env.CLAUDE_CODE_USE_FOUNDRY)) return 'FOUNDRY';
  if (isSet(env.ANTHROPIC_BASE_URL) || isSet(env.ANTHROPIC_AUTH_TOKEN)) return 'GATEWAY';
  if (isSet(env.ANTHROPIC_API_KEY)) return 'API_KEY';
  if (account === null || typeof account !== 'object') return 'UNKNOWN';
  const billing = typeof account.billingType === 'string' ? account.billingType.toLowerCase() : '';
  const orgType = typeof account.organizationType === 'string' ? account.organizationType.toLowerCase() : '';
  if (billing.includes('subscription') || orgType.startsWith('claude_')) return 'SUBSCRIPTION';
  return billing !== '' || orgType !== '' ? 'API_KEY' : 'UNKNOWN';
}

/**
 * Reads Claude Code's signed-in account record (`<CLAUDE_CONFIG_DIR or ~>/.claude.json` → `oauthAccount`),
 * keeping only the two billing fields; null when absent or unreadable. Never sent anywhere.
 */
export function readClaudeAccount(env, home = homedir()) {
  try {
    const file = path.join(isSet(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : home, '.claude.json');
    const account = JSON.parse(readFileSync(file, 'utf8'))?.oauthAccount;
    if (account === null || typeof account !== 'object') return null;
    return { billingType: account.billingType ?? null, organizationType: account.organizationType ?? null };
  } catch {
    return null;
  }
}

/** The source for this process: its environment plus the signed-in account. */
function currentSource() {
  return usageSource(process.env, readClaudeAccount(process.env));
}

/** The `model_usage` report: per model, the active attempt's cumulative counts (one request per message). */
export function usageReport(state, source) {
  return usageOf(state.usage.messages, source);
}

/** The `model_usage` report of one story's messages (active or parked, HH-290). */
function usageOf(messages, source) {
  const byModel = new Map();
  for (const [model, input, output, cacheCreation, cacheRead] of Object.values(messages)) {
    const total = byModel.get(model) ?? { model, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, requests: 0, source };
    total.input_tokens += input;
    total.output_tokens += output;
    total.cache_creation_tokens += cacheCreation;
    total.cache_read_tokens += cacheRead;
    total.requests += 1;
    byModel.set(model, total);
  }
  const clamp = (n) => Math.min(n, USAGE_COUNT_MAX);
  return [...byModel.values()]
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))
    .slice(0, USAGE_MODELS_MAX)
    .map((t) => ({ ...t, input_tokens: clamp(t.input_tokens), output_tokens: clamp(t.output_tokens), cache_creation_tokens: clamp(t.cache_creation_tokens), cache_read_tokens: clamp(t.cache_read_tokens), requests: clamp(t.requests) }));
}

/**
 * The complete lines a transcript gained since the last read (the stored offset moves past them; a
 * trailing partial line waits). A shorter file than the offset was replaced: it is read from the start.
 */
export function readNewTranscriptLines(state, file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const stored = state.usage.transcripts[file] ?? 0;
    const from = stored > size ? 0 : stored;
    const length = Math.min(size - from, TRANSCRIPT_READ_MAX_BYTES);
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, from);
    const end = buffer.lastIndexOf(0x0a);
    if (end === -1) return [];
    state.usage.transcripts[file] = from + end + 1;
    return buffer.subarray(0, end).toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

/** Reads the session transcript's new lines into the usage; a failure leaves the usage as it was. */
function absorbSessionTranscript(state) {
  const file = state.usage.transcript;
  if (state.story === null || typeof file !== 'string') return;
  try {
    absorbTranscript(state, readNewTranscriptLines(state, file));
  } catch {
    // Unreadable or gone: the usage of this stretch is lost, the session goes on.
  }
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
  if (parsed === null || typeof parsed !== 'object') return emptyState();
  // A buffer written before HH-171 has no usage: start it empty.
  return { ...emptyState(), ...parsed, usage: { ...emptyUsage(), ...(parsed.usage ?? {}) } };
}

function readOr(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * HH-679 — both clients (Claude Code hooks, the Pi extension) write the one buffer of a project, so it
 * is written atomically: a temp file unique to this write, then a rename. A reader sees the old buffer
 * or the new one, never half of either; a failed write leaves no temp file behind.
 */
export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** A tool response that reports a failure (a refused work_complete leaves the buffer for a retry). */
function failed(response) {
  const value = typeof response === 'string' ? safeJson(response) ?? response : response;
  return value?.isError === true || /"code"\s*:\s*"(VALIDATION|FORBIDDEN|CONFLICT|BUSINESS|NOT_FOUND)_/.test(JSON.stringify(value ?? ''));
}

/** HH-681 — the SessionStart answer: the quiet work_progress sends as context for the agent (empty: none). */
function sessionStartOutput(state, cwd, now) {
  const note = sessionStartNote(sessionStartSends(state, now, currentSource()), pointerProjectId(projectRootFor(cwd)));
  return note === null ? '' : JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } });
}

/** The PreToolUse answer for a delivering call (empty: run it untouched). */
function attachOutput(state, event, now) {
  absorbSessionTranscript(state);
  const tool = String(event.tool_name);
  const reason = deliveryReminder(state, tool, event.tool_input ?? {}, now, currentSource());
  if (reason === null) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function main(argv, stdin, now) {
  const command = argv[0];
  if (command === 'hook') {
    const event = safeJson(stdin) ?? {};
    const file = stateFileFor(event.cwd ?? process.cwd());
    const state = loadState(file);
    const tool = String(event.tool_name ?? '');
    let out = '';
    if (event.hook_event_name === 'PreToolUse' && DELIVERING_TOOL.test(tool)) {
      out = attachOutput(state, event, now);
    } else if (event.hook_event_name === 'PostToolUse' && /__work_/.test(tool) && failed(event.tool_response)) {
      event.tool_failed = true;
    } else if (event.hook_event_name === 'PostToolUse' && /__work_complete$/.test(tool)) {
      absorbSessionTranscript(state);
      const note = undeliveredNote(state, event.tool_input, currentSource());
      if (note !== null) out = JSON.stringify({ systemMessage: note });
    }
    applyEvent(state, event, now);
    if (event.hook_event_name === 'Stop' || event.hook_event_name === 'SessionEnd') absorbSessionTranscript(state);
    if (event.hook_event_name === 'SessionStart') out = sessionStartOutput(state, event.cwd ?? process.cwd(), now);
    saveState(file, state);
    return out;
  }
  if (command === 'take') {
    const file = stateFileFor(process.cwd());
    const state = loadState(file);
    const segments = take(state, now);
    saveState(file, state);
    return JSON.stringify(segments);
  }
  if (command === 'usage') {
    const file = stateFileFor(process.cwd());
    const state = loadState(file);
    expireIfDue(state, now);
    absorbSessionTranscript(state);
    saveState(file, state);
    return JSON.stringify(usageReport(state, currentSource()));
  }
  return '';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Hooks must never block a session: any failure is swallowed (exit 0, nothing printed).
  try {
    const stdin = process.argv[2] === 'hook' ? readFileSync(0, 'utf8') : '';
    process.stdout.write(main(process.argv.slice(2), stdin, Date.now()));
  } catch {
    if (process.argv[2] === 'take' || process.argv[2] === 'usage') process.stdout.write('[]');
  }
}
