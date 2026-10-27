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
// CLI: `effort-capture.mjs hook` (reads the hook event JSON on stdin) · `effort-capture.mjs take`
// (prints the pending segments as a JSON array for the work_* call; `[]` when none) ·
// `effort-capture.mjs usage` (prints the model usage as a JSON array for `model_usage`; `[]` when none).
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
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

const TEST_COMMAND = /\b(test|tests|vitest|jest|playwright|pytest|lint|eslint|tsc|typecheck|go test|cargo test)\b/;

/** A fresh, story-less state. */
export function emptyState() {
  return { story: null, step: 'PLANNING', open: null, seq: 0, pending: [], usage: emptyUsage(), reminded: {} };
}

/** No usage yet: per message id `[model, input, output, cacheCreation, cacheRead]`; read offsets per transcript. */
function emptyUsage() {
  return { messages: {}, transcripts: {}, transcript: null };
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
  const id = typeof payload?.story?.id === 'string' ? payload.story.id : null;
  return { key, id, leaseExpiresAt: Number.isNaN(expires) ? now + LEASE_TTL_MS : expires, claimedAt: now };
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
    // HH-199 — a call the Hub refused delivered nothing: the buffer stays for the retry.
    if (event.tool_failed !== true) applyWorkCall(state, tool, event.tool_input, now);
    setStep(state, stepForTool(tool, event.tool_input, state.step), now);
  }
}

/** A successful work_* call: drop what it sent, renew the lease view, end on complete/release. */
function applyWorkCall(state, tool, toolInput, now) {
  if (!/__work_(progress|verify|complete|release)$/.test(tool)) return;
  const sent = sentSeqs(toolInput);
  state.pending = state.pending.filter((s) => !sent.has(s.seq));
  state.reminded = {};
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

// ---- delivery (HH-199) -------------------------------------------------------------------------

/** The work_* calls that carry measured effort to the Hub. */
const DELIVERING_TOOL = /__work_(progress|verify|complete)$/;

/** Whether a work_* call names the claimed story (by key or by id). */
function namesClaimedStory(state, toolInput) {
  const named = toolInput?.story_id;
  return state.story !== null && typeof named === 'string' && (named === state.story.key || named === state.story.id);
}

/**
 * The input a delivering work_* call should carry: the caller's own input plus the pending segments it
 * lacks (by seq) and, for verify / complete, the model usage when it carries none. When measured
 * segments go along, a human_ms / ai_ms estimate is dropped — measured time wins. Null when there is
 * nothing to add (another tool, another story, nothing measured), so the call runs untouched.
 */
export function attachEffort(state, toolName, toolInput, now, source) {
  if (!DELIVERING_TOOL.test(toolName) || !namesClaimedStory(state, toolInput)) return null;
  const sent = sentSeqs(toolInput);
  const segments = take(state, now).filter((segment) => !sent.has(segment.seq));
  const usage = /__work_progress$/.test(toolName) || Array.isArray(toolInput.model_usage) ? [] : usageReport(state, source);
  if (segments.length === 0 && usage.length === 0) return null;
  const next = { ...toolInput };
  if (segments.length > 0) {
    next.segments = [...(Array.isArray(toolInput.segments) ? toolInput.segments : []), ...segments];
    delete next.human_ms;
    delete next.ai_ms;
  }
  if (usage.length > 0) next.model_usage = usage;
  return next;
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
  return [
    `holycode-hub: this call leaves out the effort measured on ${state.story.key}. Call it again with these fields added`,
    drop.length > 0 ? ` and without ${drop.join(' / ')}` : '',
    ` (counts and timestamps only): ${JSON.stringify(add)}`,
  ].join('');
}

/**
 * After a work_complete: what was measured but did not travel with it (the Hub accepts effort only up
 * to completion), as a short note for the developer — or null when everything went along.
 */
export function undeliveredNote(state, toolInput, source) {
  if (!namesClaimedStory(state, toolInput)) return null;
  const sent = sentSeqs(toolInput);
  const segments = state.pending.filter((segment) => !sent.has(segment.seq)).length;
  const usage = Array.isArray(toolInput?.model_usage) && toolInput.model_usage.length > 0 ? 0 : usageReport(state, source).length;
  if (segments === 0 && usage === 0) return null;
  const what = [segments > 0 ? `${segments} measured time segment${segments === 1 ? '' : 's'}` : null, usage > 0 ? 'the token counts' : null].filter(Boolean).join(' and ');
  return `holycode-hub: ${state.story.key} was completed without ${what}; the Hub accepts them only up to completion, so they are not recorded.`;
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

/** How the member pays for the model: an API key in the environment is per token, else a subscription. */
export function usageSource(env) {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY !== '' ? 'API_KEY' : 'SUBSCRIPTION';
}

/** The `model_usage` report: per model, the attempt's cumulative counts (one request per message). */
export function usageReport(state, source) {
  const byModel = new Map();
  for (const [model, input, output, cacheCreation, cacheRead] of Object.values(state.usage.messages)) {
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

export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

/** A tool response that reports a failure (a refused work_complete leaves the buffer for a retry). */
function failed(response) {
  const value = typeof response === 'string' ? safeJson(response) ?? response : response;
  return value?.isError === true || /"code"\s*:\s*"(VALIDATION|FORBIDDEN|CONFLICT|BUSINESS|NOT_FOUND)_/.test(JSON.stringify(value ?? ''));
}

/** The PreToolUse answer for a delivering call (empty: run it untouched). */
function attachOutput(state, event, now) {
  absorbSessionTranscript(state);
  const tool = String(event.tool_name);
  const reason = deliveryReminder(state, tool, event.tool_input ?? {}, now, usageSource(process.env));
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
      const note = undeliveredNote(state, event.tool_input, usageSource(process.env));
      if (note !== null) out = JSON.stringify({ systemMessage: note });
    }
    applyEvent(state, event, now);
    if (event.hook_event_name === 'Stop' || event.hook_event_name === 'SessionEnd') absorbSessionTranscript(state);
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
    return JSON.stringify(usageReport(state, usageSource(process.env)));
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
