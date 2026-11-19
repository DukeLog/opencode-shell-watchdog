import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
  learnedOf,
  MESSAGE_CAP,
  parseDirective,
  parseDuration,
  parseOptions,
  parseProcesses,
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
  verifyLeader,
  verifySurvivors,
  wantsTag,
} from "../src/core.js";

const MIN = 60_000;
const TAG = "0a1b2c3d-1111-2222-3333-444455556666";

function record(settings = {}, extra = {}) {
  return createRecord(
    { id: "sh_1", sessionID: "ses_1", pid: 4242, file: "/out", command: "./job.sh", dir: "/p", workspace: null, startedWall: 1_000_000, ...extra },
    { ...SETTING_DEFAULTS, ...settings },
  );
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

test("directive is read from the first line only", () => {
  const directive = parseDirective("# watchdog: report=5m silence=off\n./train.sh", "/bin/zsh");
  assert.equal(directive.found, true);
  assert.deepEqual(directive.pairs, [["report", "5m"], ["silence", "off"]]);

  assert.equal(parseDirective("./train.sh # watchdog: kill-runtime=1s", "/bin/zsh").found, false);
  assert.equal(parseDirective("echo '# watchdog: kill-runtime=1s'", "/bin/bash").found, false);
  assert.equal(parseDirective("cat <<EOF\n# watchdog: kill-runtime=1s\nEOF", "/bin/sh").found, false);
  assert.equal(parseDirective("\n# watchdog: report=5m\n./x", "/bin/sh").found, false, "not the first line");
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

test("kill limits need a tag", () => {
  const untagged = record({ killRuntime: MIN });
  pass(untagged, 10 * MIN);
  assert.equal(killReason(untagged), null);

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
  assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.ps1", "/usr/bin/pwsh", defaults, "linux"), false, "no trap line there");
  for (const shell of ["/bin/sh", "/bin/bash", "/usr/bin/zsh", "/bin/dash", "/bin/ash", "/usr/bin/fish"]) {
    assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", shell, defaults, "linux"), true, shell);
  }
  for (const shell of ["/bin/ksh", "/bin/mksh", "/usr/bin/tcsh", "/usr/bin/python3", ""]) {
    assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", shell, defaults, "linux"), false, shell);
  }
  assert.equal(wantsTag("# watchdog: off kill-runtime=2h\n./job.sh", "/bin/zsh", defaults, "linux"), false);
  assert.equal(wantsTag("./job.sh", "/bin/bash", { ...defaults, killSilence: 30 * MIN }, "linux"), true, "limit from options");
  assert.equal(wantsTag("# watchdog: kill-silence=off\n./job.sh", "/bin/bash", { ...defaults, killSilence: 30 * MIN }, "linux"), false);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h reprot=5m\n./job.sh", "/bin/zsh", defaults, "linux"), false, "a directive with an error arms nothing");
});

test("tag: two lines in front of the command, both removed again", () => {
  const command = "# watchdog: kill-runtime=2h\n./job.sh";
  const tagged = addTag(command, TAG);
  assert.equal(tagged, `# shell-watchdog:${TAG}\ntrap : EXIT\n# watchdog: kill-runtime=2h\n./job.sh`);
  assert.deepEqual(splitTag(tagged), { tag: TAG, command });
  assert.deepEqual(parseDirective(splitTag(tagged).command, "/bin/zsh").pairs, [["kill-runtime", "2h"]], "the directive is the first line again");
  assert.deepEqual(splitTag(addTag("trap : EXIT\n./job.sh", TAG)), { tag: TAG, command: "trap : EXIT\n./job.sh" }, "a trap line of the command itself stays");
  assert.deepEqual(splitTag(`# shell-watchdog:${TAG.toUpperCase()}\n./job.sh`), { tag: TAG, command: "./job.sh" });

  assert.deepEqual(splitTag("./job.sh"), { tag: null, command: "./job.sh" });
  assert.equal(splitTag("echo hi\n# shell-watchdog:" + TAG + "\n").tag, null, "only as the first line");
  assert.equal(splitTag(`# shell-watchdog:${TAG}`).tag, null, "only as a whole line");
  assert.equal(stripTags(addTag(addTag(command, TAG), TAG.replace("0a", "0b"))), command, "every tag layer is removed");
  assert.equal(stripTags(command), command);
});

test("kill is refused for a pid that is not the tagged command", () => {
  const target = { pid: 4242, tag: TAG };
  const processes = [{ pid: 4242, pgid: 4242, startedWall: 1_000_000 }];
  const argv = `/bin/zsh +o nomatch -c # shell-watchdog:${TAG}\\012./job.sh`;
  assert.equal(verifyLeader(processes, argv, target), null, "macOS ps: the line break is shown as \\012");
  assert.equal(verifyLeader(processes, `/bin/zsh -c # shell-watchdog:${TAG}\n./job.sh`, target), null, "a real line break");
  assert.equal(verifyLeader(processes, `sh -c # shell-watchdog:${TAG} ./job.sh exit`, target), null, "procps: the line break is shown as a space");
  assert.equal(verifyLeader(processes, `sh -c # shell-watchdog:${TAG}`, target), null, "end of the command line");

  // The original exited, another group leader got its pid, the exit event is late.
  assert.match(verifyLeader(processes, "/usr/bin/some-daemon --serve", target), /is not the command/);
  assert.match(verifyLeader(processes, "", target), /is not the command/, "ps found no such process");
  assert.match(verifyLeader(processes, `/bin/zsh -c # shell-watchdog:${TAG}ff\\012x`, target), /is not the command/, "the whole tag");
  assert.match(verifyLeader(processes, `/bin/zsh -c # shell-watchdog:${TAG}XYZ\\012x`, target), /is not the command/, "nothing glued to it");
  assert.match(verifyLeader(processes, `/bin/zsh -c # shell-watchdog:${TAG}-x`, target), /is not the command/);
  assert.match(verifyLeader(processes, `/bin/zsh -c # shell-watchdog:${TAG.replace("0a", "0b")}\\012x`, target), /is not the command/);

  // The tag proves something only as the first line of the script the shell was started with.
  assert.equal(verifyLeader(processes, `/bin/bash -lc # shell-watchdog:${TAG}\\012x`, target), null, "any option group that ends in c");
  assert.match(verifyLeader(processes, `/bin/zsh -c echo hi\\012# shell-watchdog:${TAG}\\012x`, target), /is not the command/, "further down in the script");
  assert.match(verifyLeader(processes, `/bin/zsh -c foo -c # shell-watchdog:${TAG}\\012x`, target), /is not the command/, "after a -c of the command itself");
  assert.match(verifyLeader(processes, `/bin/zsh -c echo '# shell-watchdog:${TAG}'`, target), /is not the command/);
  assert.match(verifyLeader(processes, `# shell-watchdog:${TAG}\\012x`, target), /is not the command/, "not a shell started with -c");
  assert.match(verifyLeader(processes, `/usr/bin/tail -f # shell-watchdog:${TAG}`, target), /is not the command/);
  assert.match(verifyLeader(processes, argv, { pid: 4242, tag: null }), /not launched with a kill limit/);
  assert.match(verifyLeader(null, argv, target), /could not be read/);
  assert.match(verifyLeader(processes, null, target), /could not be read/);
  assert.match(verifyLeader([], argv, target), /was not found/);
  assert.match(verifyLeader([{ pid: 4242, pgid: 7, startedWall: 0 }], argv, target), /does not lead/);
});

test("SIGKILL only for a group that predates the SIGTERM", () => {
  const entry = { pid: 4242, tag: TAG, termWall: 2_000_000 };
  const argv = `/bin/zsh -c # shell-watchdog:${TAG}\\012./job.sh`;
  const child = { pid: 5000, pgid: 4242, startedWall: 1_500_000 };
  const leader = { pid: 4242, pgid: 4242, startedWall: 1_000_000 };
  assert.equal(verifySurvivors([child], "", entry), null, "leader gone, an old child is left");
  assert.equal(verifySurvivors([child], null, entry), null, "leader gone: its command line is not needed");
  assert.equal(verifySurvivors([leader, child], argv, entry), null, "the leader is still the tagged command");
  assert.equal(verifySurvivors([leader, child], "", entry), null, "the leader exited between the two readings");
  assert.match(verifySurvivors([leader, child], null, entry), /could not be checked/, "the leader is there and unverified");
  assert.match(verifySurvivors([{ pid: 4242, pgid: 4242, startedWall: 2_500_000 }], "/usr/bin/other", entry), /another process/);
  assert.match(verifySurvivors([{ pid: 5000, pgid: 4242, startedWall: 2_500_000 }], "", entry), /predates/);
  assert.match(verifySurvivors([{ pid: 5000, pgid: 4242, startedWall: 1_999_000 }], "", entry), /predates/, "ps is exact to a second only");
  assert.equal(verifySurvivors([{ pid: 5000, pgid: 4242, startedWall: 1_998_000 }], "", entry), null);
  assert.match(verifySurvivors([], "", entry), /predates/);
  assert.match(verifySurvivors(null, argv, entry), /could not be read/);
});

test("ps output", () => {
  const wall = 10_000_000_000;
  const processes = parseProcesses("    1     1 04-20:12:33\n  196   190 01:00:27\n 7032  7032       00:01\nnoise\n", wall);
  assert.deepEqual(processes, [
    { pid: 1, pgid: 1, startedWall: wall - ((4 * 24 + 20) * 3600 + 12 * 60 + 33) * 1000 },
    { pid: 196, pgid: 190, startedWall: wall - (3600 + 27) * 1000 },
    { pid: 7032, pgid: 7032, startedWall: wall - 1000 },
  ]);
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
