// Registry, tick and delivery.
//
// One state object is shared by every instance of the plugin inside a server process (one instance per
// location, a new one on every reload). It holds plain data only. Everything that touches the outside
// world goes through `io`, so the whole thing can be driven by tests.

import {
  DAY,
  KILL_SETTINGS,
  absorb,
  addTag,
  applySettings,
  budgetFooter,
  commit,
  composeMessage,
  createRecord,
  decide,
  escalationNotice,
  expireSnooze,
  killArmed,
  killNotice,
  killReason,
  killRefusedNotice,
  parseDirective,
  parseDuration,
  parseSettings,
  reportBlock,
  resolveSettings,
  setObserve,
  splitLines,
  splitTag,
  statusBlock,
  stripTags,
  tailLines,
  taint,
  verifyLeader,
  verifySurvivors,
  wantsTag,
} from "./core.js";

// Bump the number when the shape of the state changes: a reloaded plugin must not inherit a state
// it does not understand.
const KEY = Symbol.for("opencode-shell-watchdog/state-2");

const MAX_READ = 256 * 1024;
const MAX_LINE = 64 * 1024;
const TAIL_READ = 8 * 1024;
const API_TIMEOUT = 10_000;
const KILL_GRACE = 5_000;
const TOMBSTONE_TTL = 10 * 60_000;
const PENDING_TTL = 60 * 60_000;
const PENDING_CAP = 500;
const NOTICE_TTL = 60 * 60_000;
const TERMINATING_TTL = 10 * 60_000;
const ISSUED_TTL = 10 * 60_000;
const ISSUED_CAP = 1000;
const DEFAULT_TICK = 30_000;

export function createState() {
  return {
    shells: new Map(), // id -> record of a watched command
    pending: new Map(), // id -> { raw, at }: commands of a location without a live instance
    done: new Map(), // id -> obs: commands that are over, so a late event cannot revive them
    issued: new Map(), // tag -> obs: tags this plugin wrote into commands that are being launched
    terminating: new Map(), // id -> permission to send SIGKILL after SIGTERM
    notices: new Map(), // sessionID -> [{ text, at, dir, workspace }]: results of automatic kills
    sessions: new Map(), // sessionID -> { wakes, sentWall, missing }
    instances: new Set(),
    obs: 0, // observed milliseconds, gaps excluded
    lastTick: null,
    lock: null,
  };
}

export function sharedState() {
  return (globalThis[KEY] ??= createState());
}

// ---------------------------------------------------------------------------------------------
// Instances and ownership

const sameLocation = (a, b) => a.dir === b.dir && (a.workspace ?? null) === (b.workspace ?? null);

/** The live instance of the location a record belongs to. Nobody else may act on the record. */
export function ownerOf(state, target) {
  let owner = null;
  for (const inst of state.instances) if (!inst.disposed && sameLocation(inst, target)) owner = inst;
  return owner;
}

export function addInstance(state, io, inst) {
  state.instances.add(inst);
  for (const [id, entry] of state.pending) {
    if (!sameLocation(inst, entry.raw)) continue;
    state.pending.delete(id);
    if (io.alive(entry.raw.pid)) activate(state, io, inst, entry.raw);
    else bury(state, id);
  }
}

export function removeInstance(state, inst) {
  inst.disposed = true;
  state.instances.delete(inst);
}

function tickOf(state) {
  let tick = Infinity;
  for (const inst of state.instances) if (!inst.disposed) tick = Math.min(tick, inst.options.tick);
  return Number.isFinite(tick) ? tick : DEFAULT_TICK;
}

// ---------------------------------------------------------------------------------------------
// Events

const bury = (state, id) => state.done.set(id, state.obs);

// Every instance has its own log file: an entry about a command belongs to the log of its owner,
// whichever instance happened to see the event or run the tick.
function log(state, io, target, entry) {
  (ownerOf(state, target)?.io ?? io).log(entry);
}

/**
 * The `create.before` hook: a command launched with a kill limit gets a tag of its own. Tags that
 * came with the command are dropped first; only a tag issued here is ever trusted.
 */
export function beforeCreate(state, io, inst, event, newTag) {
  if (inst.disposed || typeof event?.command !== "string") return;
  const command = stripTags(event.command);
  if (!wantsTag(command, event.shell, inst.settings, io.platform)) return;
  const tag = String(newTag()).toLowerCase();
  state.issued.set(tag, state.obs);
  if (state.issued.size > ISSUED_CAP) state.issued.delete(state.issued.keys().next().value);
  event.command = addTag(command, tag);
}

export function handleEvent(state, io, event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case "shell.created":
      return onCreated(state, io, data.info, event.location);
    case "shell.exited":
    case "shell.deleted":
      return onGone(state, data.id);
    case "session.deleted":
      return forgetSession(state, data.sessionID);
  }
}

function onCreated(state, io, info, location) {
  const id = info?.id;
  const sessionID = info?.metadata?.sessionID;
  if (typeof id !== "string" || typeof sessionID !== "string") return;
  if (info.status && info.status !== "running") return;
  if (!Number.isInteger(info.pid) || info.pid <= 1 || typeof info.file !== "string") return;
  if (typeof location?.directory !== "string") return;
  if (state.shells.has(id) || state.pending.has(id) || state.done.has(id)) return;

  // A tag counts once, and only if this plugin wrote it into this launch.
  const split = splitTag(info.command);
  const tag = split.tag !== null && state.issued.delete(split.tag) ? split.tag : null;
  const raw = {
    id,
    sessionID,
    pid: info.pid,
    file: info.file,
    command: stripTags(info.command),
    tag,
    shell: String(info.shell ?? ""),
    cwd: info.cwd,
    dir: location.directory,
    workspace: location.workspaceID ?? null,
    startedWall: Number(info.time?.started),
  };
  const owner = ownerOf(state, raw);
  if (owner) return activate(state, io, owner, raw);
  state.pending.set(id, { raw, at: state.obs });
  if (state.pending.size > PENDING_CAP) state.pending.delete(state.pending.keys().next().value);
}

function activate(state, io, inst, raw) {
  if (inst.options.ignore.some((pattern) => pattern.test(raw.command))) return bury(state, raw.id);
  const directive = parseDirective(raw.command, raw.shell);
  if (directive.off) return bury(state, raw.id);
  const { settings, notes } = resolveSettings(inst.settings, directive);
  if (killArmed(settings) && !raw.tag) {
    for (const key of KILL_SETTINGS) settings[key] = 0;
    notes.push("kill limits (automatic kill needs macOS or Linux, one of sh, bash, zsh, dash, ksh, fish, and a command that does not end with a backslash)");
  }
  state.shells.set(raw.id, createRecord(raw, settings, notes));
  (inst.io ?? io).log({ kind: "watch", id: raw.id, sessionID: raw.sessionID, pid: raw.pid, settings });
}

function onGone(state, id) {
  if (typeof id !== "string") return;
  state.shells.delete(id);
  state.pending.delete(id);
  bury(state, id);
}

function forgetSession(state, sessionID) {
  if (typeof sessionID !== "string") return;
  for (const [id, rec] of state.shells) if (rec.sessionID === sessionID) onGone(state, id);
  for (const [id, entry] of state.pending) if (entry.raw.sessionID === sessionID) onGone(state, id);
  for (const [id, entry] of state.terminating) if (entry.sessionID === sessionID) state.terminating.delete(id);
  state.notices.delete(sessionID);
  state.sessions.delete(sessionID);
}

function notify(state, target, text) {
  const list = state.notices.get(target.sessionID) ?? [];
  list.push({ text, at: state.obs, dir: target.dir, workspace: target.workspace });
  state.notices.set(target.sessionID, list);
}

// ---------------------------------------------------------------------------------------------
// Tick

/**
 * One pass over all watched commands. Any instance may run it; `state.lock` makes sure one pass runs
 * at a time, and every acquisition is its own lease: a pass that lost its lease stops before its next
 * side effect, so a stale pass can neither send, signal nor release someone else's lock.
 */
export async function tick(state, io, inst) {
  if (inst.disposed) return false;
  const tickMs = tickOf(state);
  const mono = io.mono();
  if (state.lock && mono - state.lock.since < 4 * tickMs) return false;
  if (state.lastTick !== null && mono - state.lastTick < 0.8 * tickMs) return false;

  const lease = (state.lock = { since: mono });
  const held = () => state.lock === lease && !inst.disposed;
  try {
    // A long gap means nobody was looking (sleep, blocked loop): none of it counts.
    const raw = state.lastTick === null ? 0 : mono - state.lastTick;
    const gap = raw < 0 || raw > 2 * tickMs;
    const delta = gap ? 0 : raw;
    state.lastTick = mono;
    state.obs += delta;
    const run = { state, io, held, delta, gap };

    sweep(run);
    await escalate(run);
    if (held()) await observe(run);
    if (held()) await enforce(run);
    if (held()) await deliver(run);
  } finally {
    if (state.lock === lease) state.lock = null;
  }
  return true;
}

function sweep({ state, io }) {
  for (const [id, at] of state.done) if (state.obs - at > TOMBSTONE_TTL) state.done.delete(id);
  for (const [tag, at] of state.issued) if (state.obs - at > ISSUED_TTL) state.issued.delete(tag);
  for (const [id, entry] of state.pending) if (state.obs - entry.at > PENDING_TTL) onGone(state, id);
  for (const [id, entry] of state.terminating) {
    if (state.obs - entry.termObs <= TERMINATING_TTL) continue;
    log(state, io, entry, { kind: "escalation-expired", id });
    state.terminating.delete(id);
  }
  for (const [sessionID, list] of state.notices) {
    const fresh = list.filter((notice) => state.obs - notice.at <= NOTICE_TTL);
    if (fresh.length) state.notices.set(sessionID, fresh);
    else state.notices.delete(sessionID);
  }
  const watched = new Set();
  for (const rec of state.shells.values()) watched.add(rec.sessionID);
  for (const [sessionID, book] of state.sessions) {
    book.wakes = book.wakes.filter((at) => state.obs - at < DAY);
    if (!book.wakes.length && !watched.has(sessionID) && !state.notices.has(sessionID)) state.sessions.delete(sessionID);
  }
}

const errorCode = (error) => String(error?.code ?? error?.name ?? "error");

const isTerminator = (byte) => byte === 0x0a || byte === 0x0d;

/**
 * Cuts complete lines out of freshly read bytes. The unfinished last line stays unread, so a partial
 * line (or half of a UTF-8 character) never looks like new output.
 * Returns { text, consumed }: consumed is how far the read offset may advance.
 */
export function takeLines(buffer, skipFirst) {
  let from = 0;
  if (skipFirst) {
    // The read started in the middle of the output: its first line is incomplete.
    const first = buffer.findIndex(isTerminator);
    from = first < 0 ? 0 : first + 1;
  }
  let end = buffer.length - 1;
  while (end >= from && !isTerminator(buffer[end])) end--;
  if (end >= from) return { text: buffer.subarray(from, end + 1).toString("utf8"), consumed: end + 1 };
  if (buffer.length - from >= MAX_LINE) return { text: buffer.subarray(from).toString("utf8"), consumed: buffer.length };
  return { text: "", consumed: from };
}

async function observe({ state, io, held, delta, gap }) {
  for (const rec of [...state.shells.values()]) {
    if (state.shells.get(rec.id) !== rec) continue;
    if (!ownerOf(state, rec)) {
      taint(rec);
      continue;
    }
    rec.clock += delta;
    if (gap) taint(rec);

    if (!io.alive(rec.pid)) {
      // The exit event normally arrives first; this covers a lost one.
      if (++rec.missing >= 2) {
        log(state, io, rec, { kind: "vanished", id: rec.id, pid: rec.pid });
        onGone(state, rec.id);
      }
      continue;
    }
    rec.missing = 0;

    // The record takes an observation only as a whole: nothing of a failed or outdated one is kept,
    // so the same bytes are simply read again on the next pass.
    const rev = rec.rev;
    const current = () => state.shells.get(rec.id) === rec && rec.rev === rev;
    let seen;
    try {
      const info = await io.stat(rec.file);
      if (!held()) return;
      if (!current()) continue;
      // Another file, or a truncated one: read it from the start.
      const restart = (rec.ino !== null && info.ino !== rec.ino) || info.size < rec.offset;
      seen = { ino: info.ino, size: info.size, offset: restart ? 0 : rec.offset, grew: restart || info.size !== rec.size, lines: [], sampled: false };
      if (seen.grew && info.size > seen.offset) {
        let start = seen.offset;
        if (info.size - start > MAX_READ) {
          start = info.size - MAX_READ;
          seen.sampled = true;
        }
        const buffer = await io.read(rec.file, start, info.size - start);
        if (!held()) return;
        if (!current()) continue;
        const taken = takeLines(buffer, seen.sampled);
        seen.offset = start + taken.consumed;
        seen.lines = splitLines(taken.text);
      }
    } catch (error) {
      if (!held()) return;
      if (current()) setObserve(rec, errorCode(error));
      continue;
    }
    if (!ownerOf(state, rec)) {
      taint(rec);
      continue;
    }
    rec.ino = seen.ino;
    rec.size = seen.size;
    rec.offset = seen.offset;
    setObserve(rec, "ok");
    absorb(rec, seen);
  }
}

/**
 * The process table and the command line of one pid, read independently: one may fail without
 * spoiling the other. processes: array or null; argv: string ("" when there is no such process) or null.
 */
async function readProcesses(io, pid) {
  const [processes, argv] = await Promise.allSettled([io.processes(), io.argv(pid)]);
  return {
    processes: processes.status === "fulfilled" && Array.isArray(processes.value) ? processes.value : null,
    argv: argv.status === "fulfilled" && typeof argv.value === "string" ? argv.value : null,
  };
}

function disarm(state, rec) {
  for (const key of KILL_SETTINGS) rec.settings[key] = 0;
  rec.rev += 1;
}

/** Automatic kill, for commands that were launched with a kill limit. */
async function enforce({ state, io, held }) {
  for (const rec of [...state.shells.values()]) {
    if (state.shells.get(rec.id) !== rec || !ownerOf(state, rec)) continue;
    const reason = killReason(rec);
    if (!reason) continue;
    const rev = rec.rev;
    const { processes, argv } = await readProcesses(io, rec.pid);
    if (!held()) return;
    if (state.shells.get(rec.id) !== rec || rec.rev !== rev || !ownerOf(state, rec)) continue;

    let refusal = verifyLeader(processes, argv, rec);
    if (!refusal) {
      try {
        io.signalGroup(rec.pid, "SIGTERM");
      } catch (error) {
        refusal = `SIGTERM failed (${errorCode(error)})`;
      }
    }
    if (refusal) {
      disarm(state, rec);
      notify(state, rec, killRefusedNotice(rec, reason, refusal));
      log(state, io, rec, { kind: "kill-refused", id: rec.id, pid: rec.pid, why: refusal });
      continue;
    }
    rec.killed = { setting: reason.setting, text: reason.text };
    state.terminating.set(rec.id, {
      id: rec.id,
      sessionID: rec.sessionID,
      dir: rec.dir,
      workspace: rec.workspace,
      pid: rec.pid,
      tag: rec.tag,
      setting: reason.setting,
      termObs: state.obs,
      termWall: io.wall(),
    });
    notify(state, rec, killNotice(rec, reason));
    log(state, io, rec, { kind: "kill", id: rec.id, pid: rec.pid, why: reason.text });
  }
}

/** SIGKILL for groups that outlived their SIGTERM. The entry is the permission; it may vanish any time. */
async function escalate({ state, io, held }) {
  for (const entry of [...state.terminating.values()]) {
    const permitted = () => state.terminating.get(entry.id) === entry && ownerOf(state, entry) !== null;
    if (!permitted()) continue;
    if (state.obs - entry.termObs < KILL_GRACE) continue;
    if (!io.groupAlive(entry.pid)) {
      state.terminating.delete(entry.id);
      continue;
    }
    const { processes, argv } = await readProcesses(io, entry.pid);
    if (!held()) return;
    if (!permitted()) continue;

    state.terminating.delete(entry.id);
    let refusal = verifySurvivors(processes, argv, entry);
    if (!refusal) {
      try {
        io.signalGroup(entry.pid, "SIGKILL");
      } catch (error) {
        refusal = `SIGKILL failed (${errorCode(error)})`;
      }
    }
    notify(state, entry, escalationNotice(entry, !refusal, refusal ?? ""));
    log(state, io, entry, { kind: refusal ? "escalation-refused" : "escalation", id: entry.id, pid: entry.pid, why: refusal });
  }
}

// ---------------------------------------------------------------------------------------------
// Delivery

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isNotFound(error) {
  const text = `${error?._tag ?? ""} ${error?.name ?? ""} ${error?.code ?? ""} ${error?.message ?? ""}`;
  return error?.status === 404 || /not.?found/i.test(text);
}

function bookOf(state, sessionID) {
  let book = state.sessions.get(sessionID);
  if (!book) state.sessions.set(sessionID, (book = { wakes: [], sentWall: 0, missing: 0 }));
  return book;
}

async function deliver(run) {
  const { state } = run;
  const batches = new Map();
  const batchOf = (sessionID, owner) => {
    if (!batches.has(sessionID)) batches.set(sessionID, { owner, items: [] });
    return batches.get(sessionID);
  };
  for (const rec of state.shells.values()) {
    const owner = ownerOf(state, rec);
    if (!owner) continue;
    expireSnooze(rec, owner.options);
    const decision = decide(rec, owner.options);
    if (decision.stall || decision.periodic) batchOf(rec.sessionID, owner).items.push({ rec, decision, rev: rec.rev });
  }
  for (const [sessionID, notices] of state.notices) {
    const owner = ownerOf(state, notices[0]);
    if (owner) batchOf(sessionID, owner);
  }
  // Sessions are independent: one that hangs must not hold back the others.
  await Promise.allSettled([...batches].map(([sessionID, batch]) => deliverSession(run, sessionID, batch)));
}

async function deliverSession({ state, io: tickIO, held }, sessionID, { owner, items }) {
  const io = owner.io ?? tickIO;
  const options = owner.options;
  const book = bookOf(state, sessionID);
  const budgetLeft = () => options.maxWakes === 0 || book.wakes.length < options.maxWakes;
  // A stall report needs room in the session budget, unless the agent asked for the check (snooze).
  const wanted = ({ decision }) => decision.periodic || decision.forced || (decision.stall && budgetLeft());
  if (!state.notices.has(sessionID) && !items.some(wanted)) return;

  let session;
  try {
    session = await withTimeout(owner.ctx.session.get({ sessionID }), API_TIMEOUT);
    if (!session) throw Object.assign(new Error("session not found"), { status: 404 });
  } catch (error) {
    if (!held()) return;
    io.log({ kind: "session-error", sessionID, error: String(error?.message ?? error) });
    if (isNotFound(error) && ++book.missing >= 2) forgetSession(state, sessionID);
    return;
  }
  if (!held() || owner.disposed) return;
  book.missing = 0;
  const time = session.time ?? {};
  if (time.archived) return void state.notices.delete(sessionID);
  if (Number(time.busy ?? 0) > Number(time.idle ?? 0)) return;
  // Without resume a message just sits in the inbox: one at a time, until the session moves again.
  if (!options.resume && book.sentWall && Number(time.busy ?? 0) <= book.sentWall) return;

  const current = (item) => state.shells.get(item.rec.id) === item.rec && item.rec.rev === item.rev && !item.rec.killed;
  let live = items.filter((item) => current(item) && wanted(item));
  await Promise.all(live.map(async (item) => (item.tail = await readTail(io, item.rec, options.tailLines))));
  if (!held() || owner.disposed) return;

  // From here to the send nothing awaits: what is committed is exactly what goes out.
  live = live.filter((item) => current(item) && wanted(item));
  const notices = state.notices.get(sessionID) ?? [];
  if (!live.length && !notices.length) return;

  const blocks = live.map((item) => {
    const outcome = commit(item.rec, item.decision, options);
    return { id: item.rec.id, text: reportBlock({ ...item, outcome }) };
  });
  let footer = "";
  if (live.some((item) => item.decision.stall)) {
    book.wakes.push(state.obs);
    if (options.maxWakes > 0 && book.wakes.length === options.maxWakes) {
      footer = budgetFooter(options.maxWakes, DAY - (state.obs - book.wakes[0]));
    }
  }
  state.notices.delete(sessionID);
  book.sentWall = io.wall();
  const text = composeMessage(blocks, notices.map((notice) => notice.text), footer);

  // Whatever happens to this call, it was the attempt: counters already moved, so a failing API is
  // not hammered on every tick.
  try {
    await withTimeout(owner.ctx.session.synthetic({ sessionID, text, delivery: "queue", resume: options.resume }), API_TIMEOUT);
    io.log({ kind: "report", sessionID, shells: blocks.map((block) => block.id), notices: notices.length });
  } catch (error) {
    io.log({ kind: "send-failed", sessionID, error: String(error?.message ?? error) });
  }
}

async function readTail(io, rec, maxLines) {
  if (maxLines <= 0) return null;
  try {
    const info = await io.stat(rec.file);
    if (!info.size) return [];
    const start = Math.max(0, info.size - TAIL_READ);
    const buffer = await io.read(rec.file, start, info.size - start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.search(/[\r\n]/) + 1);
    return tailLines(text, maxLines);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Tool

const TOOL_FIELDS = new Set(["id", "off", "snooze", "silence", "loop", "report", "killSilence", "killRuntime"]);

function listText(state, inst, sessionID) {
  const blocks = [];
  for (const rec of state.shells.values()) {
    if (rec.sessionID === sessionID) blocks.push(statusBlock(rec, (ownerOf(state, rec) ?? inst).options));
  }
  if (!blocks.length) return "No shell command of this session is being watched right now.";
  return blocks.join("\n\n");
}

/** The `watchdog` tool: status and per-command settings, for the commands of the calling session only. */
export async function toolCall(state, io, inst, input, sessionID) {
  const args = input && typeof input === "object" ? input : {};
  const given = Object.keys(args).filter((key) => args[key] !== undefined && args[key] !== null);
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    const list = listText(state, inst, sessionID);
    return given.some((key) => key !== "id") ? `Nothing was changed: give the id of the command (sh_…).\n\n${list}` : list;
  }

  const rec = state.shells.get(id);
  const own = rec?.sessionID === sessionID ? rec : null;
  const entry = state.terminating.get(id);
  const ownEntry = entry?.sessionID === sessionID ? entry : null;
  if (!own && !ownEntry) {
    return `${id} is not a watched command of this session (it may have finished, or it was launched with "# watchdog: off").\n\n${listText(state, inst, sessionID)}`;
  }

  // The whole call is checked before any part of it is applied.
  const errors = [];
  const settingInput = {};
  for (const key of given) {
    if (!TOOL_FIELDS.has(key)) errors.push(`unknown field "${key}"`);
    else if (key !== "id" && key !== "off" && key !== "snooze") settingInput[key] = args[key];
  }
  const parsed = parseSettings(settingInput);
  errors.push(...parsed.errors.map((error) => error.text));
  const { patch } = parsed;
  if (args.off !== undefined && args.off !== null && typeof args.off !== "boolean") errors.push("off must be true or false");
  let snooze;
  if (args.snooze !== undefined && args.snooze !== null) {
    snooze = parseDuration(args.snooze);
    if (snooze === undefined) errors.push(`snooze needs a duration like 30m, or off, not "${args.snooze}"`);
  }
  if (own && KILL_SETTINGS.some((key) => patch[key] > 0) && !own.tag) {
    errors.push(
      'a kill limit cannot be added to a command that was launched without one: give it at launch, as the first line of the command, e.g. "# watchdog: kill-runtime=2h"',
    );
  }
  const options = (ownerOf(state, own ?? ownEntry) ?? inst).options;
  const status = () => (own ? statusBlock(own, options) : `${id} has finished; a SIGKILL for what is left of its process group is pending.`);
  if (errors.length) return `Nothing was changed: ${errors.join("; ")}.\n\n${status()}`;

  if (args.off === true) {
    if (ownEntry) state.terminating.delete(id);
    log(state, io, own ?? ownEntry, { kind: "tool", id, off: true });
    if (!own) return `${id}: the pending SIGKILL was cancelled.`;
    onGone(state, id);
    return `Stopped watching ${id}: no more reports and no automatic kill for it.`;
  }
  // Switching off the limit that fired withdraws the permission to escalate.
  if (ownEntry && patch[ownEntry.setting] === 0) state.terminating.delete(id);
  if (!own) return state.terminating.has(id) ? status() : `${id}: the pending SIGKILL was cancelled.`;

  if (Object.keys(patch).length) applySettings(own, patch);
  if (snooze !== undefined) {
    own.checkAt = snooze > 0 ? own.clock + snooze : 0;
    own.rev += 1;
  }
  log(state, io, own, { kind: "tool", id, patch, snooze });
  return statusBlock(own, options);
}
