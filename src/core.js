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

const SETTING_KEYS = {
  silence: "silence",
  loop: "loop",
  report: "report",
  killsilence: "killSilence",
  killruntime: "killRuntime",
};
const SETTING_LABELS = {
  silence: "silence",
  loop: "loop",
  report: "report",
  killSilence: "kill-silence",
  killRuntime: "kill-runtime",
};

export function settingKey(key) {
  return SETTING_KEYS[String(key).toLowerCase().replace(/[-_\s]/g, "")];
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
 * Validates setting values. Returns { patch, errors }: canonical keys with parsed values, and one
 * { key, text } per rejected entry (key is undefined for an unknown name).
 */
export function parseSettings(input) {
  const patch = {};
  const errors = [];
  for (const [rawKey, rawValue] of Object.entries(input ?? {})) {
    if (rawValue === undefined) continue;
    const key = settingKey(rawKey);
    if (!key) {
      errors.push({ key: undefined, text: `unknown setting "${rawKey}"` });
      continue;
    }
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
 * Settings of one command: defaults overlaid with its directive. A rejected kill value disarms that
 * kill instead of inheriting the default.
 */
export function resolveSettings(defaults, directive) {
  const { patch, errors } = parseSettings(directive?.values);
  const settings = { ...defaults, ...patch };
  for (const error of errors) if (KILL_SETTINGS.includes(error.key)) settings[error.key] = 0;
  const notes = [...(directive?.errors ?? []), ...errors.map((error) => error.text)];
  return { settings, notes };
}

const DIRECTIVE = /^\s*#+\s*watchdog\s*:\s*(.*)$/i;
// Shells where a first line starting with "#" is a comment.
const DIRECTIVE_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "fish", "pwsh", "powershell"]);

export function shellName(shell) {
  return String(shell ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}

/**
 * Per-command settings: a comment that is the first line of the command.
 *
 *     # watchdog: report=5m silence=off
 *     ./train.sh
 *
 * Only the first line is looked at, so text inside quotes or heredocs is never read as settings.
 * Applied only for shells known to treat that line as a comment.
 */
export function parseDirective(command, shell) {
  const none = { found: false, off: false, values: {}, errors: [] };
  if (!DIRECTIVE_SHELLS.has(shellName(shell))) return none;
  const first = String(command ?? "").split(/\r?\n/, 1)[0];
  const match = DIRECTIVE.exec(first);
  if (!match) return none;
  const directive = { found: true, off: false, values: {}, errors: [] };
  for (const token of match[1].trim().split(/[\s,]+/).filter(Boolean)) {
    if (/^(off|disabled?|none)$/i.test(token)) {
      directive.off = true;
      continue;
    }
    const eq = token.indexOf("=");
    if (eq <= 0 || eq === token.length - 1) {
      directive.errors.push(`could not read "${token}" (expected name=value)`);
      continue;
    }
    directive.values[token.slice(0, eq)] = token.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  return directive;
}

/** Plugin options from opencode.json. Bad values fall back to defaults and are listed in errors. */
export function parseOptions(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const settingInput = {};
  const rest = {};
  for (const [key, value] of Object.entries(input)) {
    if (settingKey(key)) settingInput[key] = value;
    else rest[key] = value;
  }
  const parsed = parseSettings(settingInput);
  const settings = { ...SETTING_DEFAULTS, ...parsed.patch };
  for (const error of parsed.errors) {
    errors.push(error.text);
    if (KILL_SETTINGS.includes(error.key)) settings[error.key] = 0;
  }

  const options = { ...OPTION_DEFAULTS, ignore: [] };
  const duration = (key, min) => {
    if (rest[key] === undefined) return;
    const ms = parseDuration(rest[key]);
    if (ms === undefined || ms < min) errors.push(`${key} needs a duration of at least ${formatDuration(min)}, not "${rest[key]}"`);
    else options[key] = ms;
  };
  const number = (key, min, max, integer) => {
    if (rest[key] === undefined) return;
    const value = Number(rest[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      errors.push(`${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}, not "${rest[key]}"`);
    } else options[key] = value;
  };
  duration("tick", 1000);
  duration("maxInterval", 1000);
  number("backoff", 1, 10, false);
  number("maxReports", 1, 100, true);
  number("maxWakes", 0, 10_000, true);
  number("tailLines", 0, 50, true);
  if (rest.resume !== undefined) {
    if (typeof rest.resume === "boolean") options.resume = rest.resume;
    else errors.push(`resume must be true or false, not "${rest.resume}"`);
  }
  if (rest.log !== undefined) {
    if (typeof rest.log === "string") options.log = rest.log;
    else errors.push("log must be a file path");
  }
  if (rest.ignore !== undefined) {
    const list = Array.isArray(rest.ignore) ? rest.ignore : [rest.ignore];
    for (const source of list) {
      try {
        options.ignore.push(new RegExp(String(source)));
      } catch {
        errors.push(`ignore pattern is not a valid regular expression: "${source}"`);
      }
    }
  }
  const known = new Set(Object.keys(OPTION_DEFAULTS));
  for (const key of Object.keys(rest)) if (!known.has(key)) errors.push(`unknown option "${key}"`);
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
    rev: 0,
    clock: 0,

    // Observation of the output file.
    observe: "ok",
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

    // Automatic kill. tag: the unique id written into the command at launch (null: kill impossible).
    // killed is set once SIGTERM went out.
    tag: raw.tag ?? null,
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
  if (rec.checkAt) {
    if (rec.clock < rec.checkAt) return decision;
    // The snooze is over: the check the agent asked for, whatever the budgets say.
    if (isStalled(view.state)) decision.stall = decision.forced = true;
  }
  if (!decision.stall && isStalled(view.state) && !rec.episode.muted) {
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

/** Why the command must be killed now, or null. Silence needs a readable output file. */
export function killReason(rec) {
  if (rec.killed || !rec.tag) return null;
  const { killRuntime, killSilence } = rec.settings;
  if (killRuntime > 0 && rec.clock >= killRuntime) {
    return { setting: "killRuntime", text: `ran for ${formatDuration(rec.clock)}, limit kill-runtime=${formatSetting(killRuntime)}` };
  }
  const quietFor = rec.clock - Math.max(rec.lastGrowth, rec.okSince);
  if (killSilence > 0 && rec.observe === "ok" && quietFor >= killSilence) {
    return { setting: "killSilence", text: `no output for ${formatDuration(quietFor)}, limit kill-silence=${formatSetting(killSilence)}` };
  }
  return null;
}

// Identity of a command that may be killed: a unique comment line written into the command when it is
// launched. It ends up in the argv of exactly that process, so a reused pid can never pass for it.
const TAG_PREFIX = "# shell-watchdog:";
const TAG_LINE = /^# shell-watchdog:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\r?\n/;

export const tagLine = (tag) => `${TAG_PREFIX}${tag}`;

export function addTag(command, tag) {
  return `${tagLine(tag)}\n${command}`;
}

/** Splits the tag line off a command: { tag, command }. tag is null when there is none. */
export function splitTag(command) {
  const text = String(command ?? "");
  const match = TAG_LINE.exec(text);
  return match ? { tag: match[1], command: text.slice(match[0].length) } : { tag: null, command: text };
}

/** Should a command about to be launched get a tag? Only when a kill limit is armed for it. */
export function wantsTag(command, shell, defaults, platform) {
  if (platform === "win32" || !DIRECTIVE_SHELLS.has(shellName(shell))) return false;
  if (splitTag(command).tag) return false;
  const directive = parseDirective(command, shell);
  return !directive.off && killArmed(resolveSettings(defaults, directive).settings);
}

// The whole tag must be there: ps shows the line break after it as "\012" or as a real newline.
function hasTag(argv, tag) {
  if (typeof argv !== "string" || !tag) return false;
  const line = tagLine(tag);
  const at = argv.indexOf(line);
  return at >= 0 && !/^[0-9a-f-]/i.test(argv.slice(at + line.length));
}

/**
 * May SIGTERM go to the process group of this pid? argv: command line of the pid as ps prints it;
 * processes: [{pid, pgid, startedWall}]. Returns null when it may, else the reason to refuse.
 */
export function verifyLeader(processes, argv, target) {
  if (!target.tag) return "the command was not launched with a kill limit";
  if (!Array.isArray(processes) || typeof argv !== "string") return "the process list could not be read";
  if (!hasTag(argv, target.tag)) return `process ${target.pid} is not the command that was launched`;
  const leader = processes.find((proc) => proc.pid === target.pid);
  if (!leader) return `process ${target.pid} was not found`;
  if (leader.pgid !== target.pid) return `process ${target.pid} does not lead its own process group`;
  return null;
}

/**
 * After SIGTERM: may the group be killed? Only when the leader is gone or still the tagged command, and
 * the group holds a process that existed before the signal (a reused group id has only younger ones).
 * Returns null when it may, else the reason to refuse.
 */
export function verifySurvivors(processes, argv, entry) {
  if (!Array.isArray(processes)) return "the process list could not be read";
  const leader = processes.find((proc) => proc.pid === entry.pid);
  if (leader && !hasTag(argv, entry.tag)) return `pid ${entry.pid} now belongs to another process`;
  const survivor = processes.some((proc) => proc.pgid === entry.pid && proc.startedWall <= entry.termWall);
  return survivor ? null : `no process of group ${entry.pid} predates the SIGTERM`;
}

/** `ps -A -o pid=,pgid=,etime=` → [{pid, pgid, startedWall}]. */
export function parseProcesses(text, wall) {
  const processes = [];
  for (const line of String(text).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, pgid, days = 0, hours = 0, minutes, seconds] = match;
    const elapsed = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
    processes.push({ pid: Number(pid), pgid: Number(pgid), startedWall: wall - elapsed * 1000 });
  }
  return processes;
}

// ---------------------------------------------------------------------------------------------
// Text

const COMMAND_CAP = 200;
const TAIL_BYTES = 1500;
const TAIL_LINE = 200;
export const MESSAGE_CAP = 6000;
const TAG = "[shell-watchdog]";

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The command without its directive line, on one line. */
export function shortCommand(command) {
  const lines = splitTag(command).command.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length && DIRECTIVE.test(lines[0])) lines.shift();
  if (!lines.length) return "(empty command)";
  const more = lines.length > 1 ? ` … (+${lines.length - 1} more lines)` : "";
  return cut(lines[0], COMMAND_CAP - more.length) + more;
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
  let bytes = 0;
  for (let i = runs.length - 1; i >= 0 && picked.length < maxLines; i--) {
    const { line, count } = runs[i];
    const shown = count > 1 ? `${cut(line, TAIL_LINE - 12)} (x${count})` : cut(line, TAIL_LINE);
    bytes += shown.length + 1;
    if (bytes > TAIL_BYTES) break;
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
  } else if (rec.settings.report > 0) {
    lines.push(`Next status in ${formatDuration(rec.settings.report)} (${call(rec.id, { report: "off" })} to stop).`);
  }
  if (rec.notes.length) lines.push(`Ignored in its watchdog settings: ${rec.notes.join("; ")}.`);
  return lines.join("\n");
}

/** Joins blocks and notices into one message, bounded in size. */
export function composeMessage(blocks, notices = [], footer = "") {
  const parts = [...notices];
  const skipped = [];
  let size = parts.join("\n\n").length + footer.length;
  for (const block of blocks) {
    if (size + block.text.length + 2 > MESSAGE_CAP && parts.length) skipped.push(block.id);
    else {
      parts.push(block.text);
      size += block.text.length + 2;
    }
  }
  if (skipped.length) parts.push(`${TAG} also due, see the watchdog tool: ${skipped.join(", ")}.`);
  if (footer) parts.push(footer);
  return parts.join("\n\n");
}

export function budgetFooter(maxWakes, freeIn) {
  return `${TAG} This used the last of ${maxWakes} stall reports allowed for this session in 24h; new stalls stay unreported for about ${formatDuration(freeIn)}. The watchdog tool still shows the state of every command.`;
}

export function killNotice(rec, reason) {
  return `${TAG} ${rec.id} was stopped by the watchdog: ${reason.text}. SIGTERM was sent to process group ${rec.pid}.\n$ ${shortCommand(rec.command)}`;
}

export function killRefusedNotice(rec, reason, why) {
  return `${TAG} ${rec.id} reached its kill limit (${reason.text}) but was NOT killed: ${why}. Automatic kill is now off for this command.\n$ ${shortCommand(rec.command)}`;
}

export function escalationNotice(entry, killed, why = "") {
  return killed
    ? `${TAG} ${entry.id}: processes of group ${entry.pid} were still alive after SIGTERM, SIGKILL was sent.`
    : `${TAG} ${entry.id}: processes of group ${entry.pid} may still be alive after SIGTERM, and SIGKILL was not sent: ${why}.`;
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
  if (rec.killed) facts.push("being stopped by the watchdog");
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
  if (rec.notes.length) lines.push(`  ignored in its settings: ${rec.notes.join("; ")}`);
  return lines.join("\n");
}
