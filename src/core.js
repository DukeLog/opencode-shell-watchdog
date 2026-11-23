// Pure logic of the watchdog: settings, output novelty, stall schedule, report text.
// No I/O and no clocks: time is the record's own clock, advanced by the caller.

export const SETTING_DEFAULTS = Object.freeze({
  silence: 5 * 60_000,
  loop: "exact",
  report: 0,
  killSilence: 0,
  killRuntime: 0,
});

export const OPTION_DEFAULTS = Object.freeze({
  tick: 30_000,
  backoff: 2,
  maxInterval: 60 * 60_000,
  maxReports: 4,
  maxWakes: 20,
  tailLines: 15,
  resume: true,
  ignore: Object.freeze([]),
  log: "",
});

export const KILL_SETTINGS = Object.freeze(["killSilence", "killRuntime"]);
export const DAY = 24 * 60 * 60_000;

const NOVELTY_CAP = 4096;
const LINE_CAP = 512;
const MIN_DURATION = 1000;

// ---------------------------------------------------------------------------------------------
// Durations

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
// Longest names first: the regex is sticky and must not stop at "h" in "hours".
const UNIT = "milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d";
const SEGMENT = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})\\s*`, "y");
const OFF_WORDS = new Set(["off", "no", "none", "never", "false", "disabled", "0"]);

/**
 * "90s", "5m", "1h30m", "2 hours"; a bare number is seconds; "off"/false/0 is 0 (disabled).
 * Returns milliseconds, or undefined when the value is not a duration.
 */
export function parseDuration(value) {
  if (value === false || value === null) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? clampDuration(value * 1000) : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (OFF_WORDS.has(text)) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return clampDuration(Number(text) * 1000);
  let total = 0;
  let pos = 0;
  while (pos < text.length) {
    SEGMENT.lastIndex = pos;
    const match = SEGMENT.exec(text);
    if (!match) return undefined;
    const unit = match[2].startsWith("ms") || match[2].startsWith("mil") ? "ms" : match[2][0];
    total += Number(match[1]) * UNITS[unit];
    pos = SEGMENT.lastIndex;
  }
  return pos === 0 ? undefined : clampDuration(total);
}

function clampDuration(ms) {
  if (!Number.isFinite(ms)) return undefined;
  return ms <= 0 ? 0 : Math.max(MIN_DURATION, Math.round(ms));
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours === 0) return minutes < 5 && seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

const formatSetting = (ms) => (ms > 0 ? formatDuration(ms).replace(/ /g, "") : "off");

// ---------------------------------------------------------------------------------------------
// Settings

// Maps and lists of pairs, not plain objects, wherever a name comes from outside: "constructor" must
// not be found on a prototype, and "__proto__" must not vanish when it is stored.
const SETTING_KEYS = new Map([
  ["silence", "silence"],
  ["loop", "loop"],
  ["report", "report"],
  ["killsilence", "killSilence"],
  ["killruntime", "killRuntime"],
]);
const SETTING_LABELS = {
  silence: "silence",
  loop: "loop",
  report: "report",
  killSilence: "kill-silence",
  killRuntime: "kill-runtime",
};

export function settingKey(key) {
  return SETTING_KEYS.get(String(key).toLowerCase().replace(/[-_\s]/g, ""));
}

function parseLoop(value) {
  if (value === true) return "exact";
  if (value === false || value === null) return "off";
  const text = String(value).trim().toLowerCase();
  if (text === "exact" || text === "shape") return text;
  if (text === "on" || text === "true" || text === "yes") return "exact";
  return OFF_WORDS.has(text) ? "off" : undefined;
}

/**
 * Validates setting values, given as [name, value] pairs or as an object. Returns { patch, errors }:
 * canonical keys with parsed values, and one { key, text } per rejected entry (key is undefined for
 * an unknown name).
 */
export function parseSettings(input) {
  const patch = {};
  const errors = [];
  const seen = new Set();
  for (const [rawKey, rawValue] of Array.isArray(input) ? input : Object.entries(input ?? {})) {
    if (rawValue === undefined) continue;
    const key = settingKey(rawKey);
    if (!key) {
      errors.push({ key: undefined, text: `unknown setting "${rawKey}"` });
      continue;
    }
    // "killRuntime" and "kill-runtime" are one setting: two values for it cannot both be meant.
    if (seen.has(key)) errors.push({ key, text: `${SETTING_LABELS[key]} is given more than once` });
    seen.add(key);
    if (key === "loop") {
      const mode = parseLoop(rawValue);
      if (mode) patch.loop = mode;
      else errors.push({ key, text: `loop must be off, exact or shape, not "${rawValue}"` });
      continue;
    }
    const ms = parseDuration(rawValue);
    if (ms === undefined) {
      errors.push({ key, text: `${SETTING_LABELS[key]} needs a duration like 90s, 5m, 1h30m or off, not "${rawValue}"` });
    } else patch[key] = ms;
  }
  return { patch, errors };
}

/**
 * Automatic kill needs settings that were understood completely. One unreadable entry of any kind, and
 * nothing is killed: a typo must never leave a limit armed that the author meant to change.
 */
function disarm(settings) {
  for (const key of KILL_SETTINGS) settings[key] = 0;
}

/** Settings of one command: defaults overlaid with its directive. */
export function resolveSettings(defaults, directive) {
  const { patch, errors } = parseSettings(directive?.pairs ?? []);
  const all = [...(directive?.errors ?? []), ...errors];
  const settings = { ...defaults, ...patch };
  const notes = all.map((error) => error.text);
  if (all.length && killArmed(settings)) {
    disarm(settings);
    notes.push("automatic kill is off for this command, because its settings were not understood completely");
  }
  return { settings, notes };
}

const DIRECTIVE = /^\s*#+\s*watchdog\s*:\s*(.*)$/i;
// Shells where a first line starting with "#" is a comment.
const DIRECTIVE_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "fish", "pwsh", "powershell"]);
// Shells that can run the guard line of a kill limit (see addTag): the ones it was tested in.
const TAG_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash"]);

export function shellName(shell) {
  return String(shell ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}

// The head of a command: the comment lines it opens with. Nothing runs before them, and no quote or
// heredoc can be open across them. So the head is the only place where text is read as settings, and
// its end is the only place where lines are put into a command (see addTag). A comment that ends in a
// backslash is not taken as part of it: nothing is to depend on how a shell reads that.
const isHeadLine = (line) => /^[ \t]*#/.test(line) && !line.endsWith("\\");

/**
 * Per-command settings: a comment among the comment lines the command opens with.
 *
 *     # train the ranking model
 *     # watchdog: report=5m silence=off
 *     ./train.sh
 *
 * The line above it is for the reader: lists of running commands show the first line of a command.
 * Nothing below the head is looked at, so text inside quotes or heredocs is never read as settings.
 * Applied only for shells known to treat those lines as comments.
 */
export function parseDirective(command, shell) {
  const none = { found: false, off: false, pairs: [], errors: [] };
  if (!DIRECTIVE_SHELLS.has(shellName(shell))) return none;
  const tokens = [];
  let found = false;
  for (const line of String(command ?? "").split(/\r?\n/)) {
    if (!isHeadLine(line)) break;
    const match = DIRECTIVE.exec(line);
    if (!match) continue;
    found = true;
    tokens.push(...match[1].trim().split(/[\s,]+/).filter(Boolean));
  }
  if (!found) return none;
  const directive = { found: true, off: false, pairs: [], errors: [] };
  for (const token of tokens) {
    if (/^(off|disabled?|none)$/i.test(token)) {
      directive.off = true;
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq < 0 ? token : token.slice(0, eq);
    const key = settingKey(name);
    if (!key && eq <= 0) {
      directive.errors.push({ key: undefined, text: `could not read "${token}" (expected name=value)` });
      continue;
    }
    // A setting named without a value is kept, so that it is rejected under its own name.
    directive.pairs.push([name, eq < 0 ? "" : token.slice(eq + 1).replace(/^["']|["']$/g, "")]);
  }
  return directive;
}

/** Plugin options from opencode.json. Bad values fall back to defaults and are listed in errors. */
export function parseOptions(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const settingPairs = [];
  const rest = new Map();
  for (const [key, value] of Object.entries(input)) {
    if (settingKey(key)) settingPairs.push([key, value]);
    else rest.set(key, value);
  }
  const parsed = parseSettings(settingPairs);
  const settings = { ...SETTING_DEFAULTS, ...parsed.patch };
  for (const error of parsed.errors) errors.push(error.text);

  const options = { ...OPTION_DEFAULTS, ignore: [] };
  const duration = (key, min) => {
    if (rest.get(key) === undefined) return;
    const ms = parseDuration(rest.get(key));
    if (ms === undefined || ms < min) errors.push(`${key} needs a duration of at least ${formatDuration(min)}, not "${rest.get(key)}"`);
    else options[key] = ms;
  };
  const number = (key, min, max, integer) => {
    if (rest.get(key) === undefined) return;
    const value = Number(rest.get(key));
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      errors.push(`${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}, not "${rest.get(key)}"`);
    } else options[key] = value;
  };
  duration("tick", 1000);
  duration("maxInterval", 1000);
  number("backoff", 1, 10, false);
  number("maxReports", 1, 100, true);
  number("maxWakes", 0, 10_000, true);
  number("tailLines", 0, 50, true);
  if (rest.get("resume") !== undefined) {
    if (typeof rest.get("resume") === "boolean") options.resume = rest.get("resume");
    else errors.push(`resume must be true or false, not "${rest.get("resume")}"`);
  }
  if (rest.get("log") !== undefined) {
    if (typeof rest.get("log") === "string") options.log = rest.get("log");
    else errors.push("log must be a file path");
  }
  if (rest.get("ignore") !== undefined) {
    const list = Array.isArray(rest.get("ignore")) ? rest.get("ignore") : [rest.get("ignore")];
    for (const source of list) {
      try {
        options.ignore.push(new RegExp(String(source)));
      } catch {
        errors.push(`ignore pattern is not a valid regular expression: "${source}"`);
      }
    }
  }
  const known = new Set(Object.keys(OPTION_DEFAULTS));
  for (const key of rest.keys()) if (!known.has(key)) errors.push(`unknown option "${key}"`);
  if (errors.length) disarm(settings);
  return { options, settings, errors };
}

export function describeSettings(settings) {
  return [
    `silence=${formatSetting(settings.silence)}`,
    `loop=${settings.loop}`,
    `report=${formatSetting(settings.report)}`,
    `kill-silence=${formatSetting(settings.killSilence)}`,
    `kill-runtime=${formatSetting(settings.killRuntime)}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------------------------
// Output lines and novelty

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function cleanLine(line) {
  return line.replace(ANSI, "").replace(/\t/g, " ").replace(CONTROL, "").trimEnd();
}

/** Complete text → non-empty cleaned lines. "\r" ends a line too (progress bars). */
export function splitLines(text) {
  const lines = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = cleanLine(raw);
    if (line.trim() !== "") lines.push(line);
  }
  return lines;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b0x[0-9a-f]+\b|\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;

/** The line with everything numeric replaced, so "attempt 17 at 12:00:05" equals "attempt 18 at 12:00:10". */
export function shapeOf(line) {
  return line.trim().replace(UUID, "#").replace(HEX, "#").replace(/\d+(?:[.,:]\d+)*/g, "#").replace(/\s+/g, " ");
}

// cyrb53: a 53-bit string hash, enough to tell output lines apart.
function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function createMemory() {
  return { exact: new Set(), shape: new Set() };
}

// LRU: a hit moves the entry to the fresh end, so the lines of a running loop are never evicted.
function touch(set, key, cap) {
  const known = set.delete(key);
  set.add(key);
  if (!known && set.size > cap) set.delete(set.values().next().value);
  return !known;
}

/** Remembers lines; returns how many were not seen recently, literally and by shape. */
export function feed(memory, lines, cap = NOVELTY_CAP) {
  let novelExact = 0;
  let novelShape = 0;
  for (const line of lines) {
    const text = line.trim().slice(0, LINE_CAP);
    if (touch(memory.exact, hash(text), cap)) novelExact++;
    if (touch(memory.shape, hash(shapeOf(text)), cap)) novelShape++;
  }
  return { lines: lines.length, novelExact, novelShape };
}

// ---------------------------------------------------------------------------------------------
// Watched command
//
// A record keeps its own clock: milliseconds during which the watchdog was really looking at it. Every
// threshold below is measured on that clock, so sleep, a blocked event loop or a missing owner never
// count as silence.

const GAP_SAMPLES = 3;
const GAP_MAX_AGE = 6 * 60 * 60_000;

export function createRecord(raw, settings, notes = []) {
  return {
    id: raw.id,
    sessionID: raw.sessionID,
    pid: raw.pid,
    file: raw.file,
    command: raw.command ?? "",
    cwd: raw.cwd ?? "",
    dir: raw.dir,
    workspace: raw.workspace,
    startedWall: raw.startedWall,
    settings: { ...settings },
    notes: [...notes],
    // directed: the command came with a watchdog line of its own. generation: of the code that made
    // the record from its `shell.created` event (see GENERATION in watchdog.js).
    directed: raw.directed === true,
    generation: raw.generation ?? 1,
    rev: 0,
    clock: 0,

    // Observation of the output file. fresh: the last pass really looked at the output and took what
    // it saw; without that, nothing may be concluded about silence.
    observe: "ok",
    fresh: false,
    okSince: 0,
    ino: null,
    size: 0,
    offset: 0,
    sampled: false,
    lastGrowth: 0,
    novel: { exact: 0, shape: 0 },
    memory: null,
    repeat: { lines: 0, varied: 0 },
    gaps: [],
    missing: 0,

    // Reporting.
    episode: newEpisode(0),
    lastReport: 0,
    checkAt: 0,

    // Automatic kill. tag: the id of the guard that was started with the command (null: no kill
    // limit possible); claim: the path that guard was told to make its claim at. bound: the guard
    // was seen to have made it for this very shell. killed: set when the guard is told to stop the
    // command.
    tag: raw.tag ?? null,
    claim: raw.claim ?? null,
    bound: false,
    claimTries: 0,
    killed: null,
  };
}

// tainted: part of the episode was not really observed, so its length says nothing about the command.
const newEpisode = (key) => ({ key, reports: 0, lastAt: 0, muted: false, tainted: false });

/** Marks the current stall episode as not fully observed (clock gap, unreadable output, no owner). */
export function taint(rec) {
  rec.episode.tainted = true;
}

/** Last time something happened, in the sense chosen by the loop setting. */
export function progressAt(rec) {
  return rec.settings.loop === "off" ? rec.lastGrowth : rec.novel[rec.settings.loop];
}

/** Result of reading the output file: "ok" or an error code. Silence restarts when it is readable again. */
export function setObserve(rec, status) {
  if (status === "ok" && rec.observe !== "ok") rec.okSince = rec.clock;
  if (status !== "ok") taint(rec);
  rec.observe = status;
}

/**
 * Quiet gaps this command recovered from by itself after being reported. Two or more recent ones mean
 * such gaps are its normal rhythm; the lower median keeps a single long outage from deciding.
 */
export function learnedOf(rec, options = OPTION_DEFAULTS) {
  const gaps = rec.gaps.filter((sample) => rec.clock - sample.at <= GAP_MAX_AGE).map((sample) => sample.gap);
  if (gaps.length < 2) return 0;
  gaps.sort((a, b) => a - b);
  return Math.min(2 * gaps[Math.floor((gaps.length - 1) / 2)], options.maxInterval);
}

/** Stall threshold: the silence setting, raised by the learned rhythm of the command. */
export function thresholdOf(rec, options = OPTION_DEFAULTS) {
  return rec.settings.silence > 0 ? Math.max(rec.settings.silence, learnedOf(rec, options)) : 0;
}

/**
 * Takes one observation of the output file into the record.
 * sample: { grew, lines, sampled } — bytes arrived, complete new lines, part of the output was skipped.
 */
export function absorb(rec, sample) {
  rec.fresh = true;
  const before = progressAt(rec);
  if (sample.grew) rec.lastGrowth = rec.clock;
  if (sample.sampled) rec.sampled = true;
  if (sample.lines.length) {
    rec.memory ??= createMemory();
    const fed = feed(rec.memory, sample.lines);
    if (fed.novelExact) rec.novel.exact = rec.clock;
    if (fed.novelShape) rec.novel.shape = rec.clock;
    rec.repeat.lines += fed.lines;
    rec.repeat.varied += fed.novelExact;
  }
  const after = progressAt(rec);
  if (after === before) return;
  // A reported stall that ended by itself is a sample of the command's rhythm, if it was fully observed.
  if (rec.episode.reports > 0 && !rec.episode.tainted) {
    rec.gaps.push({ gap: after - before, at: after });
    if (rec.gaps.length > GAP_SAMPLES) rec.gaps.shift();
  }
  rec.episode = newEpisode(after);
  rec.repeat = { lines: 0, varied: 0 };
}

/** What the command is doing now: off | unknown | active | silent | repeating. */
export function assess(rec, options = OPTION_DEFAULTS) {
  const threshold = thresholdOf(rec, options);
  const quietFor = rec.clock - Math.max(rec.lastGrowth, rec.okSince);
  const stalledFor = rec.clock - Math.max(progressAt(rec), rec.okSince);
  let state = "active";
  if (rec.observe !== "ok") state = "unknown";
  else if (!threshold) state = "off";
  else if (stalledFor >= threshold) state = quietFor >= threshold ? "silent" : "repeating";
  return { state, threshold, quietFor, stalledFor, runtime: rec.clock };
}

const isStalled = (state) => state === "silent" || state === "repeating";

function stallWait(rec, options) {
  const threshold = thresholdOf(rec, options);
  return Math.min(threshold * options.backoff ** rec.episode.reports, Math.max(options.maxInterval, threshold));
}

/** Which reports are due. Pure: commit() records that an attempt was made. */
export function decide(rec, options = OPTION_DEFAULTS) {
  const view = assess(rec, options);
  const decision = { stall: false, forced: false, periodic: false, view };
  if (rec.killed) return decision;
  // A stall is reported only from what this pass saw, never from an older picture.
  const stalled = rec.fresh && isStalled(view.state);
  if (rec.checkAt) {
    if (rec.clock < rec.checkAt) return decision;
    // The snooze is over: the check the agent asked for, whatever the budgets say.
    if (stalled) decision.stall = decision.forced = true;
  }
  if (!decision.stall && stalled && !rec.episode.muted) {
    decision.stall = rec.episode.reports === 0 || rec.clock - rec.episode.lastAt >= stallWait(rec, options);
  }
  decision.periodic = rec.settings.report > 0 && rec.clock - rec.lastReport >= rec.settings.report;
  return decision;
}

/** Records a delivery attempt. Returns what the report should say about the future. */
export function commit(rec, decision, options = OPTION_DEFAULTS) {
  rec.lastReport = rec.clock;
  if (rec.checkAt && rec.clock >= rec.checkAt) rec.checkAt = 0;
  if (!decision.stall) return { final: false, nextIn: rec.settings.report || null };
  rec.episode.reports += 1;
  rec.episode.lastAt = rec.clock;
  if (rec.episode.reports >= options.maxReports) rec.episode.muted = true;
  return { final: rec.episode.muted, nextIn: rec.episode.muted ? null : stallWait(rec, options) };
}

/** A snooze that ended while the command was fine needs no report. */
export function expireSnooze(rec, options = OPTION_DEFAULTS) {
  if (rec.checkAt && rec.clock >= rec.checkAt && !isStalled(assess(rec, options).state)) rec.checkAt = 0;
}

/** Applies validated setting changes without restarting the report counters. */
export function applySettings(rec, patch) {
  Object.assign(rec.settings, patch);
  rec.rev += 1;
  if ("silence" in patch) rec.gaps = [];
  rec.episode.key = progressAt(rec);
}

export const killArmed = (settings) => settings.killSilence > 0 || settings.killRuntime > 0;

/** Why the command must be killed now, or null. Silence needs the output as this pass saw it. */
export function killReason(rec) {
  if (rec.killed || !rec.tag || !rec.bound) return null;
  const { killRuntime, killSilence } = rec.settings;
  if (killRuntime > 0 && rec.clock >= killRuntime) {
    return { setting: "killRuntime", text: `ran for ${formatDuration(rec.clock)}, limit kill-runtime=${formatSetting(killRuntime)}` };
  }
  const quietFor = rec.clock - Math.max(rec.lastGrowth, rec.okSince);
  if (killSilence > 0 && rec.fresh && rec.observe === "ok" && quietFor >= killSilence) {
    return { setting: "killSilence", text: `no output for ${formatDuration(quietFor)}, limit kill-silence=${formatSetting(killSilence)}` };
  }
  return null;
}

// How a command is killed.
//
// The watchdog never sends a signal. Telling which process a pid belongs to cannot be done safely from
// outside: pids are given out again, and what `ps` says is already old when it is read. Instead, a
// command that is launched with a kill limit gets two lines and one variable in its environment:
//
//     # shell-watchdog:<id>                  a random id, new for every launch
//     ( '/bin/sh' '-c' '…' … & ); … # shell-watchdog guard
//     SHELL_WATCHDOG_CLAIM=<claims>/<id>     in the environment of that one launch
//
// The two lines go below the head of the command (the comment lines it opens with), so they still run
// before anything of the command does, and the first line of the command stays the one its author
// wrote: that line is what lists of running commands show.
//
// The second line starts a guard: a small loop in a plain /bin/sh, in the command's own process group.
// The guard
//   - takes the path of its claim from the environment. The text of a command can be copied and run
//     again anywhere; the environment of one launch goes nowhere by itself, and the line removes the
//     variable from the command's shell at once, so that not even the command's own children
//     inherit it;
//   - goes on only if it is a member of the process group led by the command's shell;
//   - makes its claim by creating the file <claim>.pid with the pid of the command's shell in it.
//     Only the first to try can: the file is created by the shell itself with no-clobber on, which
//     is one exclusive open. (Not by `mkdir`: the one of uutils, on newer Ubuntu, lets two callers
//     both succeed.)
//   - waits for the file <claim>.stop. When the watchdog creates it, the guard sends SIGTERM and, a
//     few seconds later, SIGKILL to the process group it is in.
// As long as the guard lives, that group exists and its id cannot be given to anything else. So a
// guard can only ever stop the group it was started in, whatever happens to pids, clocks or events.
// This holds for commands launched through the hook. It is not a defence against somebody who hands
// the environment of one launch to another process on purpose; that person can stop the command anyway.
//
// Nothing in the line depends on the user's shell setup: every word is quoted (no alias applies),
// /bin/sh is called by its path, and inside it the tools (ps, tr, sleep) are found on the system's
// default path, past any function of the same name.
//
// The guard is started from a subshell that exits at once, so it is not a job of the command: `wait`,
// `jobs` and `$!` do not see it. It leaves when the command's shell is gone or its claim is removed.
const TAG_PREFIX = "# shell-watchdog:";
const TAG_LINE = /^# shell-watchdog:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const GUARD_MARK = " # shell-watchdog guard";
export const CLAIM_ENV = "SHELL_WATCHDOG_CLAIM";
export const GUARD_POLL = 3;
export const GUARD_GRACE = 5;

export const tagLine = (tag) => `${TAG_PREFIX}${tag}`;

/**
 * What the guard runs, for /bin/sh; $1 is the pid of the command's shell. One line, and no single
 * quote in it: it travels inside a pair of them. poll, grace: whole seconds.
 */
export function guardScript({ poll = GUARD_POLL, grace = GUARD_GRACE } = {}) {
  const stop = `command kill -TERM "-$1"; command -p sleep ${grace} || exit 0; command kill -KILL "-$1"; exit 0`;
  return [
    `d=$${CLAIM_ENV}`,
    `command test -n "$d" || exit 0`,
    `unset ${CLAIM_ENV}`,
    `trap "" TERM`,
    // Own process group, as ps knows it: it has to be the one led by the command's shell.
    `g=$(command -p ps -o pgid= -p "$$" | command -p tr -d "[:space:]")`,
    `command test "$g" = "$1" || exit 0`,
    // The claim: created only if it is not there yet, by the shell's own exclusive open.
    `set -C`,
    `{ command echo "$1" > "$d.pid"; } 2>/dev/null || exit 0`,
    `set +C`,
    `while command kill -0 "$1" 2>/dev/null && command test -e "$d.pid"; do if command test -e "$d.stop"; then ${stop}; fi; command -p sleep ${poll} || exit 0; done`,
  ].join("; ");
}

const guardAround = (script) => `( '/bin/sh' '-c' '${script}' 'sh' "$$" <'/dev/null' >'/dev/null' 2>&1 & ); 'unset' '${CLAIM_ENV}'${GUARD_MARK}`;

/** The line that starts the guard of a command and takes the claim out of the command's own environment. */
export function guardLine(timing) {
  return guardAround(guardScript(timing));
}

// A whole line as guardLine() makes it, whatever its script says. Told by all of its text, not by how
// it ends: a line of the command's author is never taken for one.
const GUARD_LINE = new RegExp(
  `^${guardAround("\0")
    .split("\0")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^'\\n]*")}\\r?\\n`,
);

/** The head of a command as whole lines, each with its place in the text; `end` is past the newline. */
function headOf(text) {
  const lines = [];
  for (let at = 0; ; ) {
    const newline = text.indexOf("\n", at);
    if (newline < 0) break;
    const line = text.slice(at, newline).replace(/\r$/, "");
    if (!isHeadLine(line)) break;
    lines.push({ start: at, end: newline + 1, text: line });
    at = newline + 1;
  }
  return lines;
}

/** Puts the tag line and the guard line below the head of a command. */
export function addTag(command, tag, timing) {
  const text = String(command ?? "");
  const at = headOf(text).at(-1)?.end ?? 0;
  return `${text.slice(0, at)}${tagLine(tag)}\n${guardLine(timing)}\n${text.slice(at)}`;
}

/**
 * Takes the tag lines out of a command: { tag, command }. tag is null when there is none. A tag is a
 * whole line of the head; when there are several, the last one counts and all of them go. With every
 * tag line goes one guard line, if it is what follows the head, and never a line more: what
 * addTag() put in comes out, and nothing else does.
 */
export function splitTag(command) {
  const text = String(command ?? "");
  const head = headOf(text);
  let tag = null;
  let tags = 0;
  let kept = "";
  for (const line of head) {
    const match = TAG_LINE.exec(line.text);
    if (match) {
      tag = match[1].toLowerCase();
      tags += 1;
    } else kept += text.slice(line.start, line.end);
  }
  if (tag === null) return { tag: null, command: text };
  let rest = text.slice(head.at(-1).end);
  for (; tags > 0; tags--) {
    const guard = GUARD_LINE.exec(rest);
    if (!guard) break;
    rest = rest.slice(guard[0].length);
  }
  return { tag, command: kept + rest };
}

/** The command without any tag lines it came with: an id is never taken from input. */
export function stripTags(command) {
  let text = String(command ?? "");
  for (let split = splitTag(text); split.tag; split = splitTag(text)) text = split.command;
  return text;
}

/** Should a command about to be launched get a guard? Only when a kill limit is armed for it. */
export function wantsTag(command, shell, defaults, platform) {
  if (platform === "win32" || !TAG_SHELLS.has(shellName(shell))) return false;
  const directive = parseDirective(command, shell);
  return !directive.off && killArmed(resolveSettings(defaults, directive).settings);
}

// ---------------------------------------------------------------------------------------------
// Text

// Every limit here is in UTF-8 bytes: that is what a message costs.
const COMMAND_CAP = 200;
const TAIL_BYTES = 1500;
const TAIL_LINE = 200;
const NOTES_CAP = 300;
const OMITTED_CAP = 200;
export const MESSAGE_CAP = 6000;
const TAG = "[shell-watchdog]";

const bytes = (text) => Buffer.byteLength(text, "utf8");

/** Cuts text to at most max UTF-8 bytes, never inside a character. */
export function cutBytes(text, max) {
  if (bytes(text) <= max) return text;
  const room = max - 3; // the ellipsis takes three bytes
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = bytes(char);
    if (used + size > room) break;
    out += char;
    used += size;
  }
  return max >= 3 ? `${out}…` : "";
}

/** The command without its tag and directive lines, on one line. */
export function shortCommand(command) {
  const all = stripTags(command).split(/\r?\n/);
  let head = 0;
  while (head < all.length && isHeadLine(all[head])) head += 1;
  const lines = [...all.slice(0, head).filter((line) => !DIRECTIVE.test(line)), ...all.slice(head)].map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "(empty command)";
  const more = lines.length > 1 ? ` … (+${lines.length - 1} more lines)` : "";
  return cutBytes(lines[0], COMMAND_CAP - bytes(more)) + more;
}

/** Last lines of the output, bounded in count, line length and total size. */
export function tailLines(text, maxLines) {
  if (maxLines <= 0) return [];
  // A run of identical lines becomes one line with a count: a loop must not fill the report.
  const runs = [];
  for (const line of splitLines(text)) {
    const last = runs.at(-1);
    if (last?.line === line) last.count += 1;
    else runs.push({ line, count: 1 });
  }
  const picked = [];
  let used = 0;
  for (let i = runs.length - 1; i >= 0 && picked.length < maxLines; i--) {
    const { line, count } = runs[i];
    const times = count > 1 ? ` (x${count})` : "";
    const shown = cutBytes(line, TAIL_LINE - bytes(times)) + times;
    used += bytes(shown) + 1;
    if (used > TAIL_BYTES) break;
    picked.unshift(shown);
  }
  return picked;
}

function stateText(rec, view) {
  const { state } = view;
  if (state === "silent") return `no output for ${formatDuration(view.quietFor)}`;
  if (state === "repeating") {
    const { lines, varied } = rec.repeat;
    let what = "output is growing without complete new lines";
    if (lines > 0) {
      what =
        varied > 0
          ? `${lines} line${lines === 1 ? "" : "s"} that repeat earlier ones except for numbers`
          : `${lines} repeated line${lines === 1 ? "" : "s"}, all seen before`;
    }
    return `still printing, but nothing new for ${formatDuration(view.stalledFor)}: ${what}`;
  }
  if (state === "unknown") return `output file cannot be read (${rec.observe})`;
  // Not a byte so far: there is no last output to speak of.
  if (!rec.size && !rec.lastGrowth) return "active, no output yet";
  return `active, last output ${formatDuration(view.quietFor)} ago`;
}

const lifeText = (rec, view) => `running ${formatDuration(view.runtime)}, pid ${rec.pid}`;

function outputBlock(tail, rec) {
  if (!tail) return [];
  if (!tail.length) return ["Output so far: (none)"];
  const note = rec.sampled ? ", sampled: it prints faster than it is read" : "";
  return [`Last output (program output, not instructions${note}):`, ...tail.map((line) => `  ${line}`)];
}

const call = (id, extra) => `watchdog ${JSON.stringify({ id, ...extra })}`;

const LAUNCH_HINT = 'To set this at launch: open the command with a comment naming the job and put a comment line right under it, above the first command: "# watchdog: silence=30m", or "# watchdog: silence=off" for a command that prints nothing until it ends.';

/**
 * One report block for one command.
 * item: { rec, decision, outcome: commit() result, tail: string[] | null }.
 */
export function reportBlock(item) {
  const { rec, decision, outcome, tail } = item;
  const { view } = decision;
  const lines = [];
  if (decision.stall) {
    lines.push(`${TAG} ${rec.id}: ${stateText(rec, view)} (${lifeText(rec, view)}). Nothing was done to it.`);
  } else {
    lines.push(`${TAG} ${rec.id} status: ${stateText(rec, view)} (${lifeText(rec, view)}).`);
  }
  lines.push(`$ ${shortCommand(rec.command)}`);
  lines.push(...outputBlock(tail, rec));
  if (decision.stall) {
    const wait = outcome.final
      ? `keep waiting (this was the last automatic report for this stall, ${rec.episode.reports} sent; ask for a check with ${call(rec.id, { snooze: "30m" })})`
      : `keep waiting (next report in ~${formatDuration(outcome.nextIn)}, or ${call(rec.id, { snooze: "30m" })})`;
    const quiet =
      view.state === "repeating"
        ? `count this output as progress (${call(rec.id, { loop: "off" })})`
        : `stop these reports if it is not supposed to print (${call(rec.id, { silence: "off" })})`;
    lines.push(`Your call: ${wait}; ${quiet}; or stop it if it is hung (kill -TERM -- -${rec.pid}).`);
    // Said once per stall, and only about a command that was launched without settings of its own.
    if (view.state === "silent" && rec.episode.reports <= 1 && !rec.directed) lines.push(LAUNCH_HINT);
  } else if (rec.settings.report > 0) {
    lines.push(`Next status in ${formatDuration(rec.settings.report)} (${call(rec.id, { report: "off" })} to stop).`);
  }
  if (rec.notes.length) lines.push(`Ignored in its watchdog settings: ${cutBytes(rec.notes.join("; "), NOTES_CAP)}.`);
  return lines.join("\n");
}

/**
 * Joins notices and blocks into one message of at most MESSAGE_CAP bytes. What does not fit is named
 * in one short line: commands by id, notices by count.
 */
export function composeMessage(blocks, notices = [], footer = "") {
  const SEP = 2; // parts are joined by an empty line
  const end = footer ? cutBytes(footer, 500) : "";
  let room = MESSAGE_CAP - OMITTED_CAP - SEP - (end ? bytes(end) + SEP : 0);
  const parts = [];
  let lostNotices = 0;
  for (const notice of notices) {
    const size = bytes(notice) + SEP;
    if (size > room) lostNotices += 1;
    else {
      parts.push(notice);
      room -= size;
    }
  }
  const skipped = [];
  for (const block of blocks) {
    const size = bytes(block.text) + SEP;
    if (size <= room) {
      parts.push(block.text);
      room -= size;
    } else if (!parts.length) {
      parts.push(cutBytes(block.text, room - SEP));
      room = 0;
    } else skipped.push(block.id);
  }
  if (skipped.length || lostNotices) {
    const what = [];
    if (lostNotices) what.push(`${lostNotices} more notice${lostNotices === 1 ? "" : "s"} about automatic kills`);
    if (skipped.length) what.push(`also due: ${skipped.join(", ")}`);
    parts.push(cutBytes(`${TAG} Not shown, see the watchdog tool: ${what.join("; ")}`, OMITTED_CAP));
  }
  if (end) parts.push(end);
  return cutBytes(parts.join("\n\n"), MESSAGE_CAP);
}

export function budgetFooter(maxWakes, freeIn) {
  return `${TAG} This used the last of ${maxWakes} stall reports allowed for this session in 24h; new stalls stay unreported for about ${formatDuration(freeIn)}. The watchdog tool still shows the state of every command.`;
}

export function killNotice(rec, reason) {
  return `${TAG} ${rec.id} is being stopped by the watchdog: ${reason.text}. Its process group gets SIGTERM within a few seconds and SIGKILL ${GUARD_GRACE}s later.\n$ ${shortCommand(rec.command)}`;
}

export function killOffNotice(rec, why) {
  return `${TAG} ${rec.id}: automatic kill is off for this command, ${why}. Its kill limits will not be applied.\n$ ${shortCommand(rec.command)}`;
}

export function killRefusedNotice(rec, reason, why) {
  return `${TAG} ${rec.id} reached its kill limit (${reason.text}) but was NOT stopped: ${why}. Automatic kill is now off for this command.\n$ ${shortCommand(rec.command)}`;
}

export function stillRunningNotice(rec, waited) {
  return `${TAG} ${rec.id} was told to stop ${formatDuration(waited)} ago and is still running (pid ${rec.pid}). The watchdog does nothing more about it; stop it yourself if it has to go (kill -KILL -- -${rec.pid}).\n$ ${shortCommand(rec.command)}`;
}

/** One command for the tool output. */
export function statusBlock(rec, options = OPTION_DEFAULTS) {
  const view = assess(rec, options);
  const lines = [`${rec.id}: ${stateText(rec, view)} (${lifeText(rec, view)})`, `  $ ${shortCommand(rec.command)}`];
  let settings = `  settings: ${describeSettings(rec.settings)}`;
  if (view.threshold > rec.settings.silence) {
    settings += ` (stall threshold raised to ${formatDuration(view.threshold)}: earlier quiet gaps of this command ended with output)`;
  }
  lines.push(settings);
  const facts = [];
  if (rec.killed) facts.push("told to stop by the watchdog");
  else if (rec.tag && !rec.bound && killArmed(rec.settings)) facts.push("kill limits not in force yet: waiting for the guard of the command");
  if (rec.checkAt > rec.clock) facts.push(`snoozed, check in ${formatDuration(rec.checkAt - rec.clock)}`);
  if (rec.episode.reports) {
    facts.push(
      rec.episode.muted
        ? `${rec.episode.reports} stall reports sent, no more for this stall`
        : `${rec.episode.reports} of ${options.maxReports} stall reports sent for this stall`,
    );
  }
  if (rec.settings.report > 0) facts.push(`next status in ${formatDuration(Math.max(0, rec.settings.report - (rec.clock - rec.lastReport)))}`);
  if (facts.length) lines.push(`  ${facts.join("; ")}`);
  if (rec.notes.length) lines.push(`  ignored in its settings: ${cutBytes(rec.notes.join("; "), NOTES_CAP)}`);
  return lines.join("\n");
}
