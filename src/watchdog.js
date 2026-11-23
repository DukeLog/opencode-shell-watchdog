// Registry, tick and delivery.
//
// One state object is shared by every instance of the plugin inside a server process (one instance per
// location, a new one on every reload). It holds plain data only. Everything that touches the outside
// world goes through `io`, so the whole thing can be driven by tests.

import {
  CLAIM_ENV,
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
  expireSnooze,
  killArmed,
  killNotice,
  killOffNotice,
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
  stillRunningNotice,
  stripTags,
  tailLines,
  taint,
  wantsTag,
} from "./core.js";

// Bump the number when the shape of the state changes: a reloaded plugin must not inherit a state
// it does not understand.
const KEY = Symbol.for("opencode-shell-watchdog/state-8");

const MAX_READ = 256 * 1024;
const MAX_LINE = 64 * 1024;
const TAIL_READ = 8 * 1024;
const API_TIMEOUT = 10_000;
const TOMBSTONE_TTL = 10 * 60_000;
const PENDING_TTL = 60 * 60_000;
const PENDING_CAP = 500;
const NOTICE_TTL = 60 * 60_000;
const STALE_EVENT = 5 * 60_000;
const ISSUED_TTL = 10 * 60_000;
const ISSUED_CAP = 1000;
const CLAIM_TRIES = 2;
const CLAIM_LINGER = 60_000;
const STOP_PATIENCE = 30_000;
const DEFAULT_TICK = 30_000;

export function createState() {
  return {
    shells: new Map(), // id -> record of a watched command
    pending: new Map(), // id -> { raw, at }: commands of a location without a live instance
    done: new Map(), // id -> obs: commands that are over, so a late event cannot revive them
    space: null, // name of this server's own part of the claims directory
    issued: new Map(), // tag -> { at, claim }: ids of guards given to commands that are being launched
    obsolete: new Map(), // claim -> obs: claims that are of no use any more and will be removed
    ops: new Map(), // claim -> promise: the last operation on the files of a claim, one at a time
    unsettled: new Set(), // claims whose stop file could not be made to say what the record says
    notices: new Map(), // sessionID -> [{ text, at, dir, workspace }]: what happened to kill limits
    sessions: new Map(), // sessionID -> { wakes, sentWall, sentObs, missing }
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
    else onGone(state, id, entry.raw.claim);
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
 * The `create.before` hook: a command launched with a kill limit gets a guard, and the guard gets the
 * path of its claim through the environment of this one launch (see core.js). Whatever came in is
 * cleared first, in the text and in the environment: an id is never taken from input.
 */
export function beforeCreate(state, io, inst, event, newTag) {
  if (inst.disposed || typeof event?.command !== "string") return;
  const env = event.env && typeof event.env === "object" ? event.env : null;
  if (env) delete env[CLAIM_ENV];
  const command = stripTags(event.command);
  if (command !== event.command) event.command = command;
  if (!inst.claims || !env || !wantsTag(command, event.shell, inst.settings, io.platform)) return;
  const tag = String(newTag()).toLowerCase();
  const claim = `${inst.claims}/${tag}`;
  state.issued.set(tag, { at: state.obs, claim });
  if (state.issued.size > ISSUED_CAP) state.issued.delete(state.issued.keys().next().value);
  env[CLAIM_ENV] = claim;
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
  if (typeof id !== "string" || !Number.isInteger(info.pid) || info.pid <= 1) return;
  if (state.shells.has(id) || state.pending.has(id) || state.done.has(id)) return;
  const started = Number(info.time?.started);
  // Events may come late and more than once, but a pid has one owner at a time. An event about a
  // start that is known to be older than a watched command of the same pid is about a command that
  // is over; any other event with that pid means the watched one is over.
  if (hasLaterOwner(state, info.pid, started)) return void bury(state, id);
  release(state, io, info.pid);

  // Not watched: no session to report to, already over, or an event about a start long ago (a replay,
  // or one held up by a sleeping machine). The id is remembered all the same.
  const sessionID = info.metadata?.sessionID;
  const stale = Number.isFinite(started) && io.wall() - started > STALE_EVENT;
  const running = !info.status || info.status === "running";
  if (stale || !running || typeof sessionID !== "string" || typeof info.file !== "string" || typeof location?.directory !== "string") {
    return void bury(state, id);
  }

  // The id of a guard counts once, and only if this plugin wrote it into this launch.
  const split = splitTag(info.command);
  const issued = split.tag === null ? undefined : state.issued.get(split.tag);
  if (issued) state.issued.delete(split.tag);
  const raw = {
    id,
    sessionID,
    pid: info.pid,
    file: info.file,
    command: stripTags(info.command),
    tag: issued ? split.tag : null,
    claim: issued ? issued.claim : null,
    foreignTag: split.tag !== null && !issued,
    shell: String(info.shell ?? ""),
    cwd: info.cwd,
    dir: location.directory,
    workspace: location.workspaceID ?? null,
    startedWall: started,
  };
  const owner = ownerOf(state, raw);
  if (owner) return activate(state, io, owner, raw);
  state.pending.set(id, { raw, at: state.obs });
  if (state.pending.size > PENDING_CAP) onGone(state, state.pending.keys().next().value);
}

function activate(state, io, inst, raw) {
  if (inst.options.ignore.some((pattern) => pattern.test(raw.command))) return onGone(state, raw.id, raw.claim);
  const directive = parseDirective(raw.command, raw.shell);
  if (directive.off) return onGone(state, raw.id, raw.claim);
  const { settings, notes } = resolveSettings(inst.settings, directive);
  if (killArmed(settings) && !raw.tag) {
    for (const key of KILL_SETTINGS) settings[key] = 0;
    let why = "automatic kill needs macOS or Linux and one of sh, bash, zsh, dash, ash";
    if (raw.foreignTag) why = "the id in the command was not issued for this launch";
    else if (!inst.claims) why = "the state directory of the watchdog cannot be used";
    notes.push(`kill limits (${why})`);
  }
  state.shells.set(raw.id, createRecord({ ...raw, directed: directive.found }, settings, notes));
  (inst.io ?? io).log({ kind: "watch", id: raw.id, sessionID: raw.sessionID, pid: raw.pid, settings });
}

/** Is a watched command of this pid known to have started later than `started`? */
function hasLaterOwner(state, pid, started) {
  for (const rec of state.shells.values()) if (rec.pid === pid && started < rec.startedWall) return true;
  for (const { raw } of state.pending.values()) if (raw.pid === pid && started < raw.startedWall) return true;
  return false;
}

/**
 * A new command has this pid. Whatever was watched under the pid before is over, although its exit
 * was never announced: it is forgotten, so that no report is made about a process that is not it.
 */
function release(state, io, pid) {
  for (const rec of [...state.shells.values()]) {
    if (rec.pid !== pid) continue;
    log(state, io, rec, { kind: "pid-reused", id: rec.id, pid });
    onGone(state, rec.id);
  }
  for (const { raw } of [...state.pending.values()]) if (raw.pid === pid) onGone(state, raw.id);
}

/** Forgets a command. The claim of its guard, if it had one, is of no use any more. */
function onGone(state, id, claim = null) {
  if (typeof id !== "string") return;
  const known = state.shells.get(id) ?? state.pending.get(id)?.raw;
  for (const obsolete of [claim, known?.claim]) if (obsolete && !state.obsolete.has(obsolete)) state.obsolete.set(obsolete, state.obs);
  state.shells.delete(id);
  state.pending.delete(id);
  bury(state, id);
}

function forgetSession(state, sessionID) {
  if (typeof sessionID !== "string") return;
  for (const [id, rec] of state.shells) if (rec.sessionID === sessionID) onGone(state, id);
  for (const [id, entry] of state.pending) if (entry.raw.sessionID === sessionID) onGone(state, id);
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
 * side effect, so a stale pass can neither send nor release someone else's lock.
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
    await observe(run);
    if (held()) await bind(run);
    if (held()) await enforce(run);
    if (held()) await deliver(run);
  } finally {
    if (state.lock === lease) state.lock = null;
  }
  return true;
}

function sweep({ state, io }) {
  for (const [id, at] of state.done) if (state.obs - at > TOMBSTONE_TTL) state.done.delete(id);
  for (const [tag, issued] of state.issued) if (state.obs - issued.at > ISSUED_TTL) state.issued.delete(tag);
  for (const [id, entry] of state.pending) if (state.obs - entry.at > PENDING_TTL) onGone(state, id);
  // Claims of commands that are not watched any more: with the claim gone, the guard leaves too.
  // They stay for a while, so that a stop that was just asked for is still found by its guard.
  for (const [claim, at] of state.obsolete) {
    if (state.obs - at < CLAIM_LINGER) continue;
    state.obsolete.delete(claim);
    state.unsettled.delete(claim);
    void serial(state, claim, () => io.dropClaim(claim)).catch(() => {});
  }
  // A stop file that could not be written or removed is tried again, until it is as it should be.
  for (const claim of state.unsettled) void settleStop(state, io, claim).catch(() => {});
  for (const [sessionID, list] of state.notices) {
    const fresh = list.filter((notice) => state.obs - notice.at <= NOTICE_TTL);
    if (fresh.length) state.notices.set(sessionID, fresh);
    else state.notices.delete(sessionID);
  }
  const watched = new Set();
  for (const rec of state.shells.values()) watched.add(rec.sessionID);
  for (const [sessionID, book] of state.sessions) {
    book.wakes = book.wakes.filter((at) => state.obs - at < DAY);
    // What was sent last is remembered for a day: with resume off it decides whether more may follow.
    const recent = book.sentObs !== null && state.obs - book.sentObs < DAY;
    if (!book.wakes.length && !recent && !watched.has(sessionID) && !state.notices.has(sessionID)) state.sessions.delete(sessionID);
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
    // Until this pass has looked at the output, nothing is known about the command right now.
    rec.fresh = false;
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

function disarm(rec) {
  for (const key of KILL_SETTINGS) rec.settings[key] = 0;
  rec.rev += 1;
}

/** Takes the kill limits from a command for good, and says so if it had any. */
function unbind(state, rec, why) {
  const armed = killArmed(rec.settings);
  if (rec.claim && !state.obsolete.has(rec.claim)) state.obsolete.set(rec.claim, state.obs);
  rec.tag = null;
  rec.claim = null;
  rec.bound = false;
  disarm(rec);
  if (!armed) return;
  rec.notes.push(`kill limits (${why})`);
  notify(state, rec, killOffNotice(rec, `because ${why}`));
}

/**
 * A kill limit comes into force when the guard of the command is seen to have made the claim that was
 * prepared for it, for the very shell the command runs in. A claim made by anything else, or by
 * nobody within two passes, is never used.
 */
async function bind({ state, io, held }) {
  for (const rec of [...state.shells.values()]) {
    const waiting = () => state.shells.get(rec.id) === rec && rec.tag !== null && !rec.bound && ownerOf(state, rec) !== null;
    if (!waiting()) continue;
    let claimed;
    try {
      claimed = await io.readClaim(rec.claim);
    } catch {
      claimed = null;
    }
    if (!held()) return;
    if (!waiting()) continue;
    if (claimed === String(rec.pid)) rec.bound = true;
    else if (claimed) unbind(state, rec, "its claim was made by another process");
    else if (++rec.claimTries >= CLAIM_TRIES) unbind(state, rec, "its guard did not start");
    if (!rec.tag) log(state, io, rec, { kind: "kill-off", id: rec.id, pid: rec.pid, claimed });
  }
}

/** Runs the operations on the files of one claim one after another, whoever asks for them. */
function serial(state, claim, operation) {
  const before = state.ops.get(claim) ?? Promise.resolve();
  const next = before.then(operation, operation);
  const settled = next.then(
    () => {},
    () => {},
  );
  state.ops.set(claim, settled);
  void settled.then(() => {
    if (state.ops.get(claim) === settled) state.ops.delete(claim);
  });
  return next;
}

/**
 * Makes the stop file of a claim say what the record says at the moment the operation runs: there if
 * the command is to be stopped, not there otherwise. Because it looks at the record when it runs, and
 * runs after everything asked before it, it does not matter who asked, in which order, or how late.
 * Resolves to true when a stop is in place.
 */
function settleStop(state, io, claim) {
  return serial(state, claim, async () => {
    let wanted = false;
    for (const rec of state.shells.values()) if (rec.claim === claim && rec.killed) wanted = true;
    try {
      if (wanted) await io.requestStop(claim);
      else await io.cancelStop(claim);
    } catch (error) {
      // A stop that should be gone and is not could still be acted on: remember to try again. (A
      // stop that could not be written is given up by the caller instead: the limit is switched off.)
      if (!wanted) state.unsettled.add(claim);
      throw error;
    }
    state.unsettled.delete(claim);
    return wanted;
  });
}

/**
 * Automatic kill, for commands that were launched with a kill limit. Nothing is signalled from here:
 * the guard of the command is told to stop it, and stops the process group it lives in.
 */
async function enforce({ state, io, held }) {
  for (const rec of [...state.shells.values()]) {
    if (!held()) return;
    if (state.shells.get(rec.id) !== rec || !ownerOf(state, rec)) continue;
    if (rec.killed) {
      const waited = rec.clock - rec.killed.at;
      if (rec.killed.written && !rec.killed.reported && waited >= STOP_PATIENCE) {
        rec.killed.reported = true;
        notify(state, rec, stillRunningNotice(rec, waited));
        log(state, io, rec, { kind: "still-running", id: rec.id, pid: rec.pid });
      }
      continue;
    }
    const reason = killReason(rec);
    if (!reason) continue;
    // The decision is made and recorded here, under the lease, with nothing awaited since the checks
    // above. What follows only carries it out, and belongs to this decision alone: if the record has
    // moved on by the time the file is written (the limit switched off, the command gone), the file
    // is settled according to the record as it then is, and nothing else is touched.
    const decision = { setting: reason.setting, text: reason.text, at: rec.clock, written: false, reported: false };
    rec.killed = decision;
    let failure = null;
    try {
      await settleStop(state, io, rec.claim);
    } catch (error) {
      failure = `the stop could not be requested (${errorCode(error)})`;
    }
    if (state.shells.get(rec.id) !== rec || rec.killed !== decision) continue;
    if (failure) {
      rec.killed = null;
      disarm(rec);
      notify(state, rec, killRefusedNotice(rec, reason, failure));
      log(state, io, rec, { kind: "kill-refused", id: rec.id, pid: rec.pid, why: failure });
      continue;
    }
    decision.written = true;
    notify(state, rec, killNotice(rec, reason));
    log(state, io, rec, { kind: "kill", id: rec.id, pid: rec.pid, why: reason.text });
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
  if (!book) state.sessions.set(sessionID, (book = { wakes: [], sentWall: 0, sentObs: null, missing: 0 }));
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
  book.sentObs = state.obs;
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
  if (!own) {
    return `${id} is not a watched command of this session (it may have finished, or it was launched with "# watchdog: off").\n\n${listText(state, inst, sessionID)}`;
  }

  // The whole call is checked before any part of it is applied.
  const errors = [];
  const settingPairs = [];
  for (const key of given) {
    if (!TOOL_FIELDS.has(key)) errors.push(`unknown field "${key}"`);
    else if (key !== "id" && key !== "off" && key !== "snooze") settingPairs.push([key, args[key]]);
  }
  const parsed = parseSettings(settingPairs);
  errors.push(...parsed.errors.map((error) => error.text));
  const { patch } = parsed;
  if (args.off !== undefined && args.off !== null && typeof args.off !== "boolean") errors.push("off must be true or false");
  let snooze;
  if (args.snooze !== undefined && args.snooze !== null) {
    snooze = parseDuration(args.snooze);
    if (snooze === undefined) errors.push(`snooze needs a duration like 30m, or off, not "${args.snooze}"`);
  }
  if (KILL_SETTINGS.some((key) => patch[key] > 0) && !own.tag) {
    errors.push(
      'a kill limit cannot be added to a command that was launched without one: give it at launch, as the first line of the command, e.g. "# watchdog: kill-runtime=2h"',
    );
  }
  const options = (ownerOf(state, own) ?? inst).options;
  if (errors.length) return `Nothing was changed: ${errors.join("; ")}.\n\n${statusBlock(own, options)}`;

  if (args.off === true) {
    log(state, io, own, { kind: "tool", id, off: true });
    const stopping = own.killed ? " The stop it was already told to make goes ahead." : "";
    onGone(state, id);
    return `Stopped watching ${id}: no more reports and no automatic kill for it.${stopping}`;
  }
  if (Object.keys(patch).length) applySettings(own, patch);
  // Switching off the limit that fired takes the stop back, if its guard has not acted on it yet.
  let withdrawn = "";
  if (own.killed && patch[own.killed.setting] === 0) {
    own.killed = null;
    try {
      // Bounded: the answer of the tool must not hang on a file system that does.
      const settling = settleStop(state, io, own.claim);
      settling.catch(() => {});
      await withTimeout(settling, API_TIMEOUT);
      withdrawn = "\nThe stop that was asked for is taken back; if the guard of the command has already seen it, the command is being stopped all the same.";
    } catch (error) {
      withdrawn = `\nThe stop that was asked for could NOT be taken back yet (${errorCode(error)}): the command may still be stopped. The watchdog keeps trying.`;
      log(state, io, own, { kind: "withdraw-failed", id, error: errorCode(error) });
    }
  }
  if (snooze !== undefined) {
    own.checkAt = snooze > 0 ? own.clock + snooze : 0;
    own.rev += 1;
  }
  log(state, io, own, { kind: "tool", id, patch, snooze });
  return statusBlock(own, options) + withdrawn;
}
