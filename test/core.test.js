import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAIM_ENV,
  OPTION_DEFAULTS,
  SETTING_DEFAULTS,
  absorb,
  addTag,
  applySettings,
  assess,
  commit,
  composeMessage,
  createMemory,
  createRecord,
  cutBytes,
  decide,
  feed,
  formatDuration,
  killReason,
  guardLine,
  guardScript,
  learnedOf,
  MESSAGE_CAP,
  parseDirective,
  parseDuration,
  parseOptions,
  reportBlock,
  resolveSettings,
  setObserve,
  settingKey,
  shapeOf,
  shortCommand,
  splitLines,
  splitTag,
  statusBlock,
  stripTags,
  tailLines,
  taint,
  thresholdOf,
  wantsTag,
} from "../src/core.js";

const MIN = 60_000;
const TAG = "0a1b2c3d-1111-2222-3333-444455556666";

/** A watched command; with a tag it also has its guard, as after the first pass. */
function record(settings = {}, extra = {}) {
  const rec = createRecord(
    { id: "sh_1", sessionID: "ses_1", pid: 4242, file: "/out", command: "./job.sh", dir: "/p", workspace: null, startedWall: 1_000_000, ...extra },
    { ...SETTING_DEFAULTS, ...settings },
  );
  if (rec.tag) rec.bound = true;
  return rec;
}

/** Moves the record's clock and feeds it output, the way a tick does. */
function pass(rec, ms, lines = null) {
  rec.clock += ms;
  absorb(rec, { grew: lines !== null, lines: lines ?? [], sampled: false });
}

test("durations", () => {
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("5m"), 5 * MIN);
  assert.equal(parseDuration("1h30m"), 90 * MIN);
  assert.equal(parseDuration("2 hours"), 120 * MIN);
  assert.equal(parseDuration("15 min"), 15 * MIN);
  assert.equal(parseDuration("500ms"), 1000, "clamped to one second");
  assert.equal(parseDuration("45"), 45_000, "a bare number is seconds");
  assert.equal(parseDuration(30), 30_000);
  for (const off of ["off", "OFF", "none", "0", false, 0, null]) assert.equal(parseDuration(off), 0);
  for (const bad of ["", "soon", "5x", "m5", "5m junk", {}, undefined, -1, Number.NaN]) {
    assert.equal(parseDuration(bad), undefined, `rejects ${JSON.stringify(bad)}`);
  }
});

test("duration formatting", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(150_000), "2m 30s");
  assert.equal(formatDuration(6 * MIN + 20_000), "6m");
  assert.equal(formatDuration(65 * MIN), "1h 5m");
  assert.equal(formatDuration(120 * MIN), "2h");
});

test("directive is read from the comment lines the command opens with, and nowhere else", () => {
  const directive = parseDirective("# watchdog: report=5m silence=off\n./train.sh", "/bin/zsh");
  assert.equal(directive.found, true);
  assert.deepEqual(directive.pairs, [["report", "5m"], ["silence", "off"]]);

  // The first line is free for a name of the job: that line is what lists of commands show.
  const named = parseDirective("# train the ranking model\n# watchdog: report=5m silence=off\n./train.sh", "/bin/zsh");
  assert.equal(named.found, true);
  assert.deepEqual(named.pairs, [["report", "5m"], ["silence", "off"]]);
  assert.deepEqual(parseDirective("#!/bin/sh\n# nightly\n  # watchdog: silence=30m\n# more\n./x", "/bin/sh").pairs, [["silence", "30m"]]);
  assert.deepEqual(parseDirective("# nightly\r\n# watchdog: silence=30m\r\n./x", "/bin/sh").pairs, [["silence", "30m"]]);
  assert.equal(parseDirective("# watchdog: off", "/bin/sh").off, true, "a command that is nothing but the line");
  assert.equal(parseDirective("# nightly\n# watchdog: off\n./x", "/bin/sh").off, true);

  // Two such lines are one set of settings; the same key twice is an error, as it is on one line.
  const two = parseDirective("# watchdog: report=5m\n# nightly\n# watchdog: silence=off\n./x", "/bin/sh");
  assert.deepEqual(two.pairs, [["report", "5m"], ["silence", "off"]]);
  const twice = resolveSettings(SETTING_DEFAULTS, parseDirective("# watchdog: kill-runtime=1h\n# watchdog: kill-runtime=2h\n./x", "/bin/sh"));
  assert.equal(twice.settings.killRuntime, 0);
  assert.deepEqual(twice.notes, ["kill-runtime is given more than once", "automatic kill is off for this command, because its settings were not understood completely"]);

  // Nothing below the head is read: not after a command, an empty line, or inside quotes and heredocs.
  assert.equal(parseDirective("./train.sh # watchdog: kill-runtime=1s", "/bin/zsh").found, false);
  assert.equal(parseDirective("echo '# watchdog: kill-runtime=1s'", "/bin/bash").found, false);
  assert.equal(parseDirective("cat <<EOF\n# watchdog: kill-runtime=1s\nEOF", "/bin/sh").found, false);
  assert.equal(parseDirective("# to a file\ncat > f <<EOF\n# watchdog: kill-runtime=1s\nEOF", "/bin/sh").found, false);
  assert.equal(parseDirective("echo '\n# watchdog: kill-runtime=1s\n'", "/bin/sh").found, false);
  assert.equal(parseDirective("\n# watchdog: report=5m\n./x", "/bin/sh").found, false, "an empty line ends the head");
  assert.equal(parseDirective("# nightly\n\n# watchdog: report=5m\n./x", "/bin/sh").found, false);
  assert.equal(parseDirective("cd /srv\n# watchdog: report=5m\n./x", "/bin/sh").found, false);
  // A comment that ends in a backslash ends the head too, itself included.
  assert.equal(parseDirective("# odd \\\n# watchdog: report=5m\n./x", "/bin/sh").found, false);
  assert.equal(parseDirective("# watchdog: report=5m \\\n./x", "/bin/sh").found, false);
});

test("directive is applied only for shells where # starts a comment", () => {
  const command = "# watchdog: report=5m\n./x";
  for (const shell of ["/bin/sh", "/bin/bash", "/opt/homebrew/bin/fish", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"]) {
    assert.equal(parseDirective(command, shell).found, true, shell);
  }
  for (const shell of ["C:\\Windows\\System32\\cmd.exe", "/usr/bin/python3", "", undefined]) {
    assert.equal(parseDirective(command, shell).found, false, String(shell));
  }
});

test("directive: off, separators and unreadable tokens", () => {
  assert.equal(parseDirective("# watchdog: off\nnpm run dev", "zsh").off, true);
  const directive = parseDirective("#watchdog: report=5m, Kill-Silence=30m nonsense loop= =5m", "bash");
  assert.deepEqual(directive.pairs, [["report", "5m"], ["Kill-Silence", "30m"], ["loop", ""]], "a setting without a value is kept to be rejected by name");
  assert.deepEqual(directive.errors.map((error) => error.text), ['could not read "nonsense" (expected name=value)', 'could not read "=5m" (expected name=value)']);
});

test("automatic kill needs settings that were understood completely", () => {
  const defaults = { ...SETTING_DEFAULTS, killRuntime: 2 * 60 * MIN, killSilence: 30 * MIN };
  const limits = (line) => {
    const { settings } = resolveSettings(defaults, parseDirective(`# watchdog: ${line}\n./job.sh`, "sh"));
    return [settings.killRuntime, settings.killSilence];
  };
  assert.deepEqual(limits("report=5m"), [2 * 60 * MIN, 30 * MIN], "a clean directive leaves the defaults armed");
  assert.deepEqual(limits("kill-runtime=off"), [0, 30 * MIN], "the plain way to switch one off");
  assert.deepEqual(limits("kill-runtime=1h kill-silence=5m"), [60 * MIN, 5 * MIN]);
  const good = resolveSettings(defaults, parseDirective("# watchdog: report=5m kill_silence=20m LOOP=shape\n./job.sh", "sh"));
  assert.deepEqual(good.settings, { silence: 5 * MIN, loop: "shape", report: 5 * MIN, killSilence: 20 * MIN, killRuntime: 2 * 60 * MIN });
  assert.deepEqual(good.notes, []);
  const bad = resolveSettings(defaults, parseDirective("# watchdog: silence=nope report=2m\n./job.sh", "sh"));
  assert.equal(bad.settings.silence, SETTING_DEFAULTS.silence, "a rejected value leaves the default of that setting");
  assert.equal(bad.settings.report, 2 * MIN, "and the readable ones are applied");

  for (const broken of [
    "kill-runtime=", // empty value
    "kill-runtime", // no value at all
    "kill-runtime = 1h", // spaces around the equals sign
    "kill-runtime=soon", // not a duration
    "kill-runtime=1h killRuntime=3h", // one setting, two spellings
    "kill-runtime=bad kill-runtime=3h", // one spelling twice
    "kill-runtime=off kill-runtime=3h",
    "kil-runtime=off", // a typo that hides the word "kill"
    "kill-runtim=1h",
    "reprot=5m", // a typo in something else
    "silence=nope",
    "nonsense",
    // Names that a plain object would swallow or find on its prototype.
    "__proto__=off",
    "constructor=off",
    "toString=1",
    "hasOwnProperty=x",
  ]) {
    assert.deepEqual(limits(broken), [0, 0], broken);
    const { notes } = resolveSettings(defaults, parseDirective(`# watchdog: ${broken}\n./job.sh`, "sh"));
    assert.ok(notes.length >= 2, `${broken}: what was not understood, and that kill is off`);
  }
  const { notes } = resolveSettings(defaults, parseDirective("# watchdog: kill-runtime=\n./job.sh", "sh"));
  assert.match(notes.join("; "), /kill-runtime needs a duration.*; automatic kill is off for this command/);
  const harmless = resolveSettings(SETTING_DEFAULTS, parseDirective("# watchdog: reprot=5m\n./job.sh", "sh"));
  assert.deepEqual(harmless.notes, ['unknown setting "reprot"'], "nothing to say about kill when none was asked for");

  // The same for the options of the plugin.
  const armed = (raw) => {
    const { settings } = parseOptions(raw);
    return [settings.killRuntime, settings.killSilence];
  };
  assert.deepEqual(armed({ killRuntime: "1h", tick: "10s" }), [60 * MIN, 0]);
  assert.deepEqual(armed({ killRuntime: "off", "kill-runtime": "1s" }), [0, 0], "two spellings of one option");
  assert.deepEqual(armed({ "kill-runtime": "1s", killRuntime: "off" }), [0, 0]);
  assert.deepEqual(armed({ killRuntime: "1h", "kill-sillence": "5m" }), [0, 0]);
  assert.deepEqual(armed({ killRuntime: "1h", "kil-silence": "5m" }), [0, 0]);
  assert.deepEqual(armed({ killRuntime: "1h", tick: "never" }), [0, 0], "any option that was not understood");
  assert.match(parseOptions({ killRuntime: "off", "kill-runtime": "1s" }).errors.join("; "), /kill-runtime is given more than once/);
  // Options arrive as parsed JSON, where "__proto__" is an ordinary key.
  for (const json of ['{"killRuntime":"1s","__proto__":"off"}', '{"killRuntime":"1s","constructor":"off"}', '{"killRuntime":"1s","toString":1}']) {
    const parsed = parseOptions(JSON.parse(json));
    assert.deepEqual([parsed.settings.killRuntime, parsed.settings.killSilence], [0, 0], json);
    assert.match(parsed.errors.join("; "), /unknown option/, json);
  }
  assert.equal(settingKey("constructor"), undefined);
  assert.equal(settingKey("__proto__"), undefined);
  assert.equal(settingKey("Kill_Run-Time"), "killRuntime");
});

test("plugin options", () => {
  const parsed = parseOptions({ silence: "2m", loop: "shape", tick: "10s", maxReports: 2, ignore: ["^npm run dev", "("], bogus: 1, backoff: 0 });
  assert.equal(parsed.settings.silence, 2 * MIN);
  assert.equal(parsed.settings.loop, "shape");
  assert.equal(parsed.options.tick, 10_000);
  assert.equal(parsed.options.maxReports, 2);
  assert.equal(parsed.options.backoff, OPTION_DEFAULTS.backoff);
  assert.equal(parsed.options.ignore.length, 1);
  assert.equal(parsed.errors.length, 3);
  assert.deepEqual(parseOptions(undefined).settings, { ...SETTING_DEFAULTS });
  assert.equal(parseOptions({ killSilence: "what" }).settings.killSilence, 0);
});

test("output lines: ANSI, carriage returns, shapes", () => {
  assert.deepEqual(splitLines("a\r\n\x1b[32mb\x1b[0m\n\n10%\r20%\rdone\n"), ["a", "b", "10%", "20%", "done"]);
  assert.equal(shapeOf("[12:00:05] attempt 17 of 30 failed"), shapeOf("[12:00:10] attempt 18 of 30 failed"));
  assert.equal(shapeOf("job 3f9a1c2e-0000-4000-8000-123456789abc done"), shapeOf("job 11111111-2222-4333-8444-555555555555 done"));
  assert.notEqual(shapeOf("upload ok"), shapeOf("upload failed"));
});

test("novelty memory: the lines of a running loop are never evicted", () => {
  const memory = createMemory();
  const loop = ["waiting for server", "retrying"];
  assert.equal(feed(memory, loop, 8).novelExact, 2);
  for (let round = 0; round < 50; round++) {
    const noise = Array.from({ length: 3 }, (_, i) => `unique ${round}-${i}`);
    assert.equal(feed(memory, [...loop, ...noise], 8).novelExact, 3, "only the unique lines are new");
  }
  assert.ok(memory.exact.size <= 8);
});

test("silent command: first report at the threshold, then backoff, then quiet", () => {
  const rec = record();
  pass(rec, 4 * MIN);
  assert.equal(decide(rec).stall, false);
  pass(rec, MIN);
  let decision = decide(rec);
  assert.equal(decision.view.state, "silent");
  assert.equal(decision.stall, true);
  assert.deepEqual(commit(rec, decision), { final: false, nextIn: 10 * MIN });

  pass(rec, 9 * MIN);
  assert.equal(decide(rec).stall, false, "backoff: 10m after the first");
  pass(rec, MIN);
  assert.equal(commit(rec, decide(rec)).nextIn, 20 * MIN);
  pass(rec, 20 * MIN);
  assert.equal(commit(rec, decide(rec)).nextIn, 40 * MIN);
  pass(rec, 40 * MIN);
  decision = decide(rec);
  assert.equal(decision.stall, true);
  assert.deepEqual(commit(rec, decision), { final: true, nextIn: null }, "fourth report is the last");
  pass(rec, 600 * MIN);
  assert.equal(decide(rec).stall, false, "muted until the output changes");

  pass(rec, MIN, ["finally something new"]);
  assert.equal(assess(rec).state, "active");
  pass(rec, 5 * MIN);
  assert.equal(decide(rec).stall, true, "a new stall is a new episode");
});

test("backoff is capped by maxInterval", () => {
  const rec = record();
  const options = { ...OPTION_DEFAULTS, maxReports: 10, maxInterval: 15 * MIN };
  pass(rec, 5 * MIN);
  assert.equal(commit(rec, decide(rec, options), options).nextIn, 10 * MIN);
  pass(rec, 10 * MIN);
  assert.equal(commit(rec, decide(rec, options), options).nextIn, 15 * MIN);
});

test("loop=exact: identical output is a stall, a new line is progress", () => {
  const rec = record();
  for (let i = 0; i < 12; i++) pass(rec, 30_000, ["waiting for server"]);
  const decision = decide(rec);
  assert.equal(decision.view.state, "repeating");
  assert.equal(decision.stall, true);
  const text = reportBlock({ rec, decision, outcome: commit(rec, decision), tail: ["waiting for server"] });
  assert.match(text, /still printing, but nothing new for 5m/);
  assert.match(text, /11 repeated lines, all seen before/);
  assert.match(text, /"loop":"off"/);

  pass(rec, 30_000, ["server is up"]);
  assert.equal(assess(rec).state, "active");
});

test("loop=exact does not flag a counter, loop=shape does, loop=off never looks at lines", () => {
  const exact = record({ loop: "exact" });
  const shape = record({ loop: "shape" });
  const off = record({ loop: "off" });
  for (let i = 0; i < 12; i++) {
    const line = [`processed ${i * 10}%`];
    pass(exact, 30_000, line);
    pass(shape, 30_000, line);
    pass(off, 30_000, ["same line"]);
  }
  assert.equal(assess(exact).state, "active");
  assert.equal(assess(off).state, "active");
  const decision = decide(shape);
  assert.equal(decision.view.state, "repeating");
  assert.match(reportBlock({ rec: shape, decision, outcome: commit(shape, decision), tail: [] }), /repeat earlier ones except for numbers/);
});

test("silence=off disables every stall detector, periodic reports still run", () => {
  const rec = record({ silence: 0, report: 5 * MIN });
  for (let i = 0; i < 9; i++) pass(rec, 30_000, ["same"]);
  pass(rec, 30_000);
  const decision = decide(rec);
  assert.equal(decision.view.state, "off");
  assert.equal(decision.stall, false);
  assert.equal(decision.periodic, true);
  assert.deepEqual(commit(rec, decision), { final: false, nextIn: 5 * MIN });
  pass(rec, 4 * MIN);
  assert.equal(decide(rec).periodic, false);
  pass(rec, MIN);
  assert.equal(decide(rec).periodic, true);
});

test("a stall report also counts as the periodic one", () => {
  const rec = record({ report: 5 * MIN });
  pass(rec, 5 * MIN);
  const decision = decide(rec);
  assert.deepEqual([decision.stall, decision.periodic], [true, true]);
  commit(rec, decision);
  pass(rec, MIN);
  assert.equal(decide(rec).periodic, false);
});

test("snooze: silence until the check, then one report whatever the episode budget says", () => {
  const rec = record();
  const options = { ...OPTION_DEFAULTS, maxReports: 1 };
  pass(rec, 5 * MIN);
  assert.equal(commit(rec, decide(rec, options), options).final, true);
  rec.checkAt = rec.clock + 30 * MIN;
  pass(rec, 29 * MIN);
  assert.equal(decide(rec, options).stall, false);
  pass(rec, MIN);
  const decision = decide(rec, options);
  assert.deepEqual([decision.stall, decision.forced], [true, true]);
  commit(rec, decision, options);
  assert.equal(rec.checkAt, 0);
  pass(rec, 60 * MIN);
  assert.equal(decide(rec, options).stall, false, "back to the muted episode");
});

test("learned threshold: two recovered gaps, lower median, ageing", () => {
  const rec = record();
  const cycle = (gap, line) => {
    pass(rec, gap - 1000);
    const decision = decide(rec);
    if (decision.stall) commit(rec, decision);
    pass(rec, 1000, [line]);
  };
  cycle(6 * MIN, "tick 1");
  assert.equal(learnedOf(rec), 0, "one recovery changes nothing");
  assert.equal(thresholdOf(rec), 5 * MIN);
  cycle(6 * MIN, "tick 2");
  assert.equal(thresholdOf(rec), 12 * MIN, "two gaps: such silence is this command's rhythm");

  // Now a 6-minute gap is no longer reported.
  pass(rec, 6 * MIN - 1000);
  assert.equal(decide(rec).stall, false);
  pass(rec, 1000, ["tick 3"]);

  // One long outage among short gaps does not decide.
  pass(rec, 50 * MIN);
  commit(rec, decide(rec));
  pass(rec, 1000, ["tick 4"]);
  assert.equal(rec.gaps.length, 3);
  assert.equal(thresholdOf(rec), 12 * MIN, "lower median of 6m, 6m, 50m");

  // Samples expire, the threshold falls back.
  rec.clock += 7 * 60 * MIN;
  assert.equal(thresholdOf(rec), 5 * MIN);
});

test("learned threshold ignores gaps that were not fully observed", () => {
  const rec = record();
  for (const line of ["a", "b", "c"]) {
    pass(rec, 6 * MIN);
    commit(rec, decide(rec));
    taint(rec);
    pass(rec, 1000, [line]);
  }
  assert.deepEqual(rec.gaps, []);

  // Unreadable output anywhere between the previous progress and the recovery taints the interval,
  // also when it happened before the first report.
  pass(rec, MIN);
  setObserve(rec, "EACCES");
  pass(rec, MIN);
  setObserve(rec, "ok");
  pass(rec, 5 * MIN);
  const decision = decide(rec);
  assert.equal(decision.stall, true);
  commit(rec, decision);
  pass(rec, 1000, ["d"]);
  assert.deepEqual(rec.gaps, []);
});

test("unreadable output is not silence, and silence restarts when it is readable again", () => {
  const rec = record({ killSilence: 10 * MIN }, { tag: TAG });
  pass(rec, 3 * MIN);
  setObserve(rec, "ENOENT");
  pass(rec, 30 * MIN);
  assert.equal(assess(rec).state, "unknown");
  assert.equal(decide(rec).stall, false);
  assert.equal(killReason(rec), null, "kill-silence needs a readable output file");

  setObserve(rec, "ok");
  assert.equal(assess(rec).state, "active", "the unreadable period does not count");
  assert.equal(killReason(rec), null);
  pass(rec, 5 * MIN);
  assert.equal(decide(rec).view.state, "silent");
  pass(rec, 5 * MIN);
  assert.equal(killReason(rec)?.setting, "killSilence");
});

test("nothing is concluded about silence from a pass that did not take in the output", () => {
  const rec = record({ killSilence: 10 * MIN }, { tag: TAG });
  assert.equal(rec.fresh, false, "nothing was seen yet");
  pass(rec, 10 * MIN);
  assert.equal(decide(rec).stall, true);
  assert.equal(killReason(rec)?.setting, "killSilence");

  // The next pass could not use what it read (say, the settings changed meanwhile).
  rec.clock += 30_000;
  rec.fresh = false;
  assert.equal(decide(rec).stall, false);
  assert.equal(killReason(rec), null, "the last known picture is not evidence of silence now");
  pass(rec, 30_000);
  assert.equal(killReason(rec)?.setting, "killSilence");

  const runtime = record({ killRuntime: 10 * MIN, report: 5 * MIN }, { tag: TAG });
  runtime.clock = 10 * MIN;
  assert.equal(killReason(runtime)?.setting, "killRuntime", "runtime does not depend on the output");
  assert.equal(decide(runtime).periodic, true, "nor does a periodic report");
});

test("kill limits need a tag and the guard that claimed it", () => {
  const untagged = record({ killRuntime: MIN });
  pass(untagged, 10 * MIN);
  assert.equal(killReason(untagged), null);
  const unbound = record({ killRuntime: MIN }, { tag: TAG });
  unbound.bound = false;
  pass(unbound, 10 * MIN);
  assert.equal(killReason(unbound), null, "tagged, but its guard has not been seen yet");

  const rec = record({ killRuntime: 10 * MIN, killSilence: 0 }, { tag: TAG });
  pass(rec, 9 * MIN, ["x"]);
  assert.equal(killReason(rec), null);
  pass(rec, MIN, ["y"]);
  assert.match(killReason(rec).text, /ran for 10m, limit kill-runtime=10m/);
  rec.killed = {};
  assert.equal(killReason(rec), null, "only once");
});

test("changing settings does not restart the report counters", () => {
  const rec = record();
  pass(rec, 5 * MIN);
  commit(rec, decide(rec));
  applySettings(rec, { loop: "off", report: 10 * MIN });
  assert.equal(rec.rev, 1);
  assert.equal(rec.episode.reports, 1);
  pass(rec, 9 * MIN);
  assert.equal(decide(rec).stall, false, "still in backoff");
});

test("tag: wanted only when a kill limit is armed and the shell can carry it", () => {
  const defaults = { ...SETTING_DEFAULTS };
  assert.equal(wantsTag("./job.sh", "/bin/zsh", defaults, "darwin"), false, "commands without kill limits stay untouched");
  assert.equal(wantsTag("# watchdog: report=5m\n./job.sh", "/bin/zsh", defaults, "darwin"), false);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", "/bin/zsh", defaults, "darwin"), true);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", "/bin/zsh", defaults, "win32"), false);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", "cmd.exe", defaults, "linux"), false);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.ps1", "/usr/bin/pwsh", defaults, "linux"), false, "cannot run the guard line");
  for (const shell of ["/bin/sh", "/bin/bash", "/usr/bin/zsh", "/bin/dash", "/bin/ash"]) {
    assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", shell, defaults, "linux"), true, shell);
  }
  for (const shell of ["/usr/bin/fish", "/bin/ksh", "/bin/mksh", "/usr/bin/tcsh", "/usr/bin/python3", ""]) {
    assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", shell, defaults, "linux"), false, shell);
  }
  assert.equal(wantsTag("# watchdog: off kill-runtime=2h\n./job.sh", "/bin/zsh", defaults, "linux"), false);
  assert.equal(wantsTag("./job.sh", "/bin/bash", { ...defaults, killSilence: 30 * MIN }, "linux"), true, "limit from options");
  assert.equal(wantsTag("# watchdog: kill-silence=off\n./job.sh", "/bin/bash", { ...defaults, killSilence: 30 * MIN }, "linux"), false);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h reprot=5m\n./job.sh", "/bin/zsh", defaults, "linux"), false, "a directive with an error arms nothing");
});

test("tag: two lines below the comment lines the command opens with, both removed again", () => {
  const command = "# watchdog: kill-runtime=2h\n./job.sh";
  const tagged = addTag(command, TAG);
  const lines = tagged.split("\n");
  assert.deepEqual(lines, ["# watchdog: kill-runtime=2h", `# shell-watchdog:${TAG}`, guardLine(), "./job.sh"]);
  assert.ok(lines[2].endsWith(" # shell-watchdog guard"));
  assert.deepEqual(splitTag(tagged), { tag: TAG, command });
  assert.deepEqual(parseDirective(splitTag(tagged).command, "/bin/zsh").pairs, [["kill-runtime", "2h"]]);

  // The first line of the command stays the one its author wrote, whatever the head looks like.
  const named = "# nightly build\n# watchdog: kill-runtime=2h\n# see the runbook\ncd /srv && ./job.sh\n# done\n";
  assert.deepEqual(addTag(named, TAG).split("\n"), ["# nightly build", "# watchdog: kill-runtime=2h", "# see the runbook", `# shell-watchdog:${TAG}`, guardLine(), "cd /srv && ./job.sh", "# done", ""]);
  // Without a head the two lines come first: there is nothing they could go below.
  assert.deepEqual(addTag("./job.sh", TAG).split("\n"), [`# shell-watchdog:${TAG}`, guardLine(), "./job.sh"]);
  assert.deepEqual(addTag("\n# late\n./job.sh", TAG).split("\n").slice(0, 3), [`# shell-watchdog:${TAG}`, guardLine(), ""]);
  // Never below a comment that ends in a backslash, and never into the last line of a text.
  assert.deepEqual(addTag("# odd \\\n./job.sh", TAG).split("\n"), [`# shell-watchdog:${TAG}`, guardLine(), "# odd \\", "./job.sh"]);
  assert.deepEqual(addTag("# a\n# odd \\\n./job.sh", TAG).split("\n"), ["# a", `# shell-watchdog:${TAG}`, guardLine(), "# odd \\", "./job.sh"]);
  assert.deepEqual(addTag("# a\n# b", TAG).split("\n"), ["# a", `# shell-watchdog:${TAG}`, guardLine(), "# b"]);
  assert.deepEqual(addTag("# a\r\n./job.sh", TAG).split("\n"), ["# a\r", `# shell-watchdog:${TAG}`, guardLine(), "./job.sh"]);
  for (const text of [named, "./job.sh", "\n# late\n./job.sh", "# odd \\\n./job.sh", "# a\n# odd \\\n./job.sh", "# a\n# b", "# a\r\n./job.sh", "", "# only"]) {
    assert.deepEqual(splitTag(addTag(text, TAG)), { tag: TAG, command: text }, JSON.stringify(text));
    assert.equal(stripTags(text), text);
  }

  // What an older version put in front of a command is still understood.
  assert.deepEqual(splitTag(`# shell-watchdog:${TAG}\n${guardLine()}\n${command}`), { tag: TAG, command });
  assert.deepEqual(splitTag(`# shell-watchdog:${TAG.toUpperCase()}\n./job.sh`), { tag: TAG, command: "./job.sh" }, "a tag line without its guard line");
  assert.deepEqual(splitTag(`# shell-watchdog:${TAG}\r\n./job.sh`), { tag: TAG, command: "./job.sh" });

  assert.deepEqual(splitTag("./job.sh"), { tag: null, command: "./job.sh" });
  assert.equal(splitTag("echo hi\n# shell-watchdog:" + TAG + "\n").tag, null, "only in the head");
  assert.equal(splitTag("# a\n\n# shell-watchdog:" + TAG + "\n./job.sh").tag, null, "only in the head");
  assert.equal(splitTag(`cat <<EOF\n# shell-watchdog:${TAG}\nEOF\n`).tag, null);
  assert.equal(splitTag(`# shell-watchdog:${TAG}`).tag, null, "only as a whole line");
  assert.equal(splitTag(`# shell-watchdog:${TAG} x\n./job.sh`).tag, null, "only as a whole line");
  assert.equal(splitTag(`# a\n${guardLine()}\n./job.sh`).command, `# a\n${guardLine()}\n./job.sh`, "a guard line alone is left where it is");

  // Several tags: the last one counts, and every one of them goes, with the guard lines.
  const other = TAG.replace("0a", "0b");
  assert.equal(stripTags(addTag(addTag(command, TAG), other)), command, "every tag layer is removed");
  assert.equal(splitTag(addTag(addTag(command, TAG), other)).tag, other);
  assert.equal(stripTags(`# shell-watchdog:${TAG}\n${guardLine()}\n${addTag(command, other)}`), command, "old layout around the new one");
  assert.equal(stripTags(`# shell-watchdog:${TAG}\n# nightly\n./job.sh`), "# nightly\n./job.sh", "a tag that is not the last line of the head");
  assert.equal(stripTags(command), command);
});

test("the guard line: the same for every command, immune to the user's shell, and sure of its group", () => {
  const line = guardLine();
  const script = guardScript();
  assert.equal(line, guardLine(), "nothing of one launch is in the text: the claim comes with the environment");
  assert.doesNotMatch(line, /\n/);
  assert.doesNotMatch(script, /'/, "the script travels inside single quotes");
  assert.equal(line, `( '/bin/sh' '-c' '${script}' 'sh' "$$" <'/dev/null' >'/dev/null' 2>&1 & ); 'unset' '${CLAIM_ENV}' # shell-watchdog guard`);
  assert.equal(CLAIM_ENV, "SHELL_WATCHDOG_CLAIM");

  // Outside the script every word is quoted, so no alias applies, and the shell is called by its path.
  const outside = line.replace(`'${script}'`, "'…'").replace(/ # shell-watchdog guard$/, "");
  for (const word of outside.split(/\s+/)) {
    assert.match(word, /^(\(|\)|\);|&|'[^']*'|"\$\$"|<'[^']*'|>'[^']*'|2>&1)$/, `unquoted word: ${word}`);
  }

  // Inside: the claim from the environment, taken out of it at once; the guard's own group checked;
  // one claim; tools found past functions and the user's PATH; every wait checked.
  const steps = script.split("; ");
  assert.deepEqual(steps.slice(0, 10), [
    "d=$SHELL_WATCHDOG_CLAIM",
    'command test -n "$d" || exit 0',
    "unset SHELL_WATCHDOG_CLAIM",
    'trap "" TERM',
    'g=$(command -p ps -o pgid= -p "$$" | command -p tr -d "[:space:]")',
    'command test "$g" = "$1" || exit 0',
    "set -C",
    '{ command echo "$1" > "$d.pid"',
    "} 2>/dev/null || exit 0",
    "set +C",
  ]);
  assert.doesNotMatch(script, /mkdir/, "the claim is made by the shell itself, not by a tool that may not be atomic");
  assert.ok(script.endsWith('while command kill -0 "$1" 2>/dev/null && command test -e "$d.pid"; do if command test -e "$d.stop"; then command kill -TERM "-$1"; command -p sleep 5 || exit 0; command kill -KILL "-$1"; exit 0; fi; command -p sleep 3 || exit 0; done'));
  assert.doesNotMatch(script, /kill -[A-Z0-9]+ "?-?0"?(;| )/, "never the group the guard merely happens to be in");
  assert.doesNotMatch(script.replace(/command -p (ps|tr|sleep)|command (test|echo|kill)/g, ""), /\b(ps|tr|mkdir|sleep|test|echo|kill)\b/, "no tool is called by its bare name");
  assert.match(guardScript({ poll: 1, grace: 2 }), /command -p sleep 2 \|\| exit 0; command kill -KILL "-\$1"; exit 0; fi; command -p sleep 1 \|\| exit 0; done$/);
});

const size = (text) => Buffer.byteLength(text, "utf8");

test("texts are cut by bytes, never inside a character", () => {
  assert.equal(cutBytes("short", 10), "short");
  assert.equal(cutBytes("abcdefghij", 8), "abcde…");
  assert.equal(size(cutBytes("ж".repeat(100), 21)), 21, "9 two-byte letters and the ellipsis");
  assert.equal(cutBytes("😀😀😀", 8), "😀…", "a four-byte character is kept whole or dropped");
  for (const max of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const cut = cutBytes("я😀я😀", max);
    assert.ok(size(cut) <= max, `${max}: ${size(cut)} bytes`);
    assert.doesNotMatch(cut, /�/);
  }
});

test("report text is bounded", () => {
  assert.equal(shortCommand(addTag("# watchdog: report=5m\n./a.sh\n./b.sh", TAG)), "./a.sh … (+1 more lines)");
  assert.equal(shortCommand(addTag("# nightly build\n# watchdog: kill-runtime=2h\n./a.sh\n./b.sh", TAG)), "# nightly build … (+2 more lines)", "the name of the job is shown, its settings are not");
  assert.equal(shortCommand("# watchdog: report=5m\n# watchdog: silence=off\n./a.sh"), "./a.sh");
  assert.equal(shortCommand("./a.sh\n# watchdog: report=5m\n./b.sh"), "./a.sh … (+2 more lines)", "below the head it is a line like any other");
  assert.equal(shortCommand(addTag("./job.sh", TAG)), "./job.sh", "neither of the two tag lines is shown");
  assert.ok(size(shortCommand("x".repeat(5000))) <= 200);
  assert.ok(size(shortCommand(`${"я".repeat(5000)}\nmore`)) <= 200);
  assert.equal(shortCommand(""), "(empty command)");

  const tail = tailLines(Array.from({ length: 100 }, (_, i) => `line ${i} ${"y".repeat(400)}`).join("\n"), 15);
  assert.ok(tail.length >= 1 && tail.length <= 15);
  assert.ok(tail.every((line) => size(line) <= 200));
  assert.ok(size(tail.join("\n")) <= 1500);
  assert.match(tail.at(-1), /^line 99 /);
  assert.deepEqual(tailLines("a\nb", 0), []);
  assert.deepEqual(tailLines("start\nwaiting\nwaiting\nwaiting\ndone\n", 15), ["start", "waiting (x3)", "done"]);

  const wide = tailLines(Array.from({ length: 100 }, (_, i) => `строка ${i} ${"ы".repeat(400)}`).join("\n"), 15);
  assert.ok(wide.length >= 1);
  assert.ok(wide.every((line) => size(line) <= 200), "a line limit is bytes, not letters");
  assert.ok(size(wide.join("\n")) <= 1500);
  const repeated = tailLines(`${"ы".repeat(400)}\n`.repeat(7), 15);
  assert.equal(repeated.length, 1);
  assert.ok(size(repeated[0]) <= 200 && repeated[0].endsWith(" (x7)"));
});

test("a message keeps to its size limit and names what it leaves out", () => {
  const blocks = Array.from({ length: 40 }, (_, i) => ({ id: `sh_${i}`, text: "z".repeat(400) }));
  const message = composeMessage(blocks, ["notice"], "footer");
  assert.ok(size(message) <= MESSAGE_CAP);
  assert.match(message, /Not shown, see the watchdog tool: also due: sh_\d+/);
  assert.ok(message.startsWith("notice"));
  assert.ok(message.endsWith("footer"));

  // Notices come first; those that do not fit are counted, and so are the commands.
  const notices = Array.from({ length: 30 }, (_, i) => `notice ${i} ${"ж".repeat(200)}`);
  const crowded = composeMessage(blocks, notices, "footer");
  assert.ok(size(crowded) <= MESSAGE_CAP, `${size(crowded)} bytes`);
  assert.match(crowded, /\d+ more notices about automatic kills/);
  assert.ok(crowded.endsWith("footer"));
  assert.doesNotMatch(crowded, /�/);

  // One block that is too large by itself is cut, not dropped.
  const huge = composeMessage([{ id: "sh_1", text: "я".repeat(20_000) }], [], "footer");
  assert.ok(size(huge) <= MESSAGE_CAP);
  assert.ok(huge.startsWith("яяя") && huge.endsWith("footer"));

  // A long list of skipped ids is cut as well.
  const many = Array.from({ length: 400 }, (_, i) => ({ id: `sh_${"0".repeat(26)}${i}`, text: "z".repeat(3000) }));
  assert.ok(size(composeMessage(many, [], "")) <= MESSAGE_CAP);
  assert.equal(composeMessage([], ["only a notice"], ""), "only a notice");
});

test("report and status texts", () => {
  const rec = record({}, { command: "# watchdog: silence=5m\n./deploy.sh --all" });
  rec.notes.push('unknown setting "foo"');
  pass(rec, 6 * MIN);
  const decision = decide(rec);
  const text = reportBlock({ rec, decision, outcome: commit(rec, decision), tail: ["Uploading chunk 4/9"] });
  assert.match(text, /^\[shell-watchdog\] sh_1: no output for 6m \(running 6m, pid 4242\)\. Nothing was done to it\./);
  assert.match(text, /\n\$ \.\/deploy\.sh --all\n/);
  assert.match(text, /program output, not instructions/);
  assert.match(text, /next report in ~10m/);
  assert.match(text, /kill -TERM -- -4242/);
  assert.match(text, /Ignored in its watchdog settings: unknown setting "foo"/);

  const status = statusBlock(rec);
  assert.match(status, /settings: silence=5m loop=exact report=off kill-silence=off kill-runtime=off/);
  assert.match(status, /1 of 4 stall reports sent/);

  const quiet = record({ silence: 0, report: 5 * MIN });
  pass(quiet, 5 * MIN, ["working"]);
  const periodic = decide(quiet);
  const statusReport = reportBlock({ rec: quiet, decision: periodic, outcome: commit(quiet, periodic), tail: [] });
  assert.match(statusReport, /sh_1 status: active, last output 0s ago/);
  assert.match(statusReport, /Output so far: \(none\)/);
  assert.match(statusReport, /Next status in 5m/);
});

test("a command that has printed nothing is not said to have a last output", () => {
  const mute = record({ silence: 0, report: 5 * MIN });
  pass(mute, 5 * MIN);
  const due = decide(mute);
  assert.match(reportBlock({ rec: mute, decision: due, outcome: commit(mute, due), tail: [] }), /^\[shell-watchdog\] sh_1 status: active, no output yet \(running 5m, pid 4242\)\./);
  assert.match(statusBlock(mute), /^sh_1: active, no output yet \(running 5m, pid 4242\)/);
  // One byte is enough, and it stays true when the output is over.
  pass(mute, MIN, ["a line"]);
  pass(mute, 2 * MIN);
  assert.match(statusBlock(mute), /^sh_1: active, last output 2m ago \(running 8m, pid 4242\)/);
  // With stall reports on, silence from the start is called silence, as before.
  const silent = record();
  pass(silent, 6 * MIN);
  assert.match(statusBlock(silent), /^sh_1: no output for 6m \(running 6m, pid 4242\)/);
});

test("the first report of a silence says how to set the limit at launch, once, and only if nothing was set", () => {
  const HINT = /\nTo set this when launching a command, give it a comment line near the top: "# watchdog: silence=30m", or "# watchdog: silence=off" for one that prints nothing until it ends\.$/;
  const say = (rec) => {
    const decision = decide(rec);
    assert.equal(decision.stall, true);
    return reportBlock({ rec, decision, outcome: commit(rec, decision), tail: [] });
  };
  const plain = record();
  pass(plain, 6 * MIN);
  assert.match(say(plain), HINT);
  pass(plain, 10 * MIN);
  assert.doesNotMatch(say(plain), /when launching/, "not again for the same silence");
  pass(plain, MIN, ["back"]);
  pass(plain, 6 * MIN);
  assert.match(say(plain), HINT, "a new silence is a new occasion");

  const directed = record({}, { directed: true });
  pass(directed, 6 * MIN);
  assert.doesNotMatch(say(directed), /when launching/, "its author knows the line already");

  const looping = record();
  for (let i = 0; i < 14; i++) pass(looping, 30_000, ["retrying"]);
  const loop = say(looping);
  assert.match(loop, /still printing, but nothing new/);
  assert.doesNotMatch(loop, /when launching/, "the hint is about silence");
});
