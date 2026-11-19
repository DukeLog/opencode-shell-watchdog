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
  shapeOf,
  shortCommand,
  splitLines,
  splitTag,
  statusBlock,
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
  assert.deepEqual(directive.values, { report: "5m", silence: "off" });

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
  const directive = parseDirective("#watchdog: report=5m, Kill-Silence=30m nonsense loop=", "bash");
  assert.deepEqual(directive.values, { report: "5m", "Kill-Silence": "30m" });
  assert.equal(directive.errors.length, 2);
});

test("settings of a command: directive over defaults, a bad kill value disarms", () => {
  const defaults = { ...SETTING_DEFAULTS, killRuntime: 2 * 60 * MIN };
  const good = resolveSettings(defaults, parseDirective("# watchdog: report=5m kill_silence=30m\nx", "sh"));
  assert.equal(good.settings.report, 5 * MIN);
  assert.equal(good.settings.killSilence, 30 * MIN);
  assert.equal(good.settings.killRuntime, 2 * 60 * MIN);
  assert.deepEqual(good.notes, []);

  const bad = resolveSettings(defaults, parseDirective("# watchdog: kill-runtime=soon silence=nope foo=1\nx", "sh"));
  assert.equal(bad.settings.killRuntime, 0, "a rejected kill value never inherits the default");
  assert.equal(bad.settings.silence, SETTING_DEFAULTS.silence, "other settings keep their default");
  assert.equal(bad.notes.length, 3);
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

test("tag: added only when a kill limit is armed, never twice", () => {
  const defaults = { ...SETTING_DEFAULTS };
  assert.equal(wantsTag("./job.sh", "/bin/zsh", defaults, "darwin"), false, "commands without kill limits stay untouched");
  assert.equal(wantsTag("# watchdog: report=5m\n./job.sh", "/bin/zsh", defaults, "darwin"), false);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", "/bin/zsh", defaults, "darwin"), true);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", "/bin/zsh", defaults, "win32"), false);
  assert.equal(wantsTag("# watchdog: kill-runtime=2h\n./job.sh", "cmd.exe", defaults, "linux"), false);
  assert.equal(wantsTag("# watchdog: off kill-runtime=2h\n./job.sh", "/bin/zsh", defaults, "linux"), false);
  assert.equal(wantsTag("./job.sh", "/bin/bash", { ...defaults, killSilence: 30 * MIN }, "linux"), true, "limit from options");
  assert.equal(wantsTag("# watchdog: kill-silence=off\n./job.sh", "/bin/bash", { ...defaults, killSilence: 30 * MIN }, "linux"), false);

  const tagged = addTag("# watchdog: kill-runtime=2h\n./job.sh", TAG);
  assert.equal(wantsTag(tagged, "/bin/zsh", defaults, "darwin"), false);
  const split = splitTag(tagged);
  assert.equal(split.tag, TAG);
  assert.equal(parseDirective(split.command, "/bin/zsh").values["kill-runtime"], "2h", "the directive is still the first line");
  assert.deepEqual(splitTag("./job.sh"), { tag: null, command: "./job.sh" });
  assert.equal(splitTag("echo hi\n# shell-watchdog:" + TAG + "\n").tag, null, "only as the first line");
});

test("kill is refused for a pid that is not the tagged command", () => {
  const target = { pid: 4242, tag: TAG };
  const processes = [{ pid: 4242, pgid: 4242, startedWall: 1_000_000 }];
  const argv = `/bin/zsh +o nomatch -c # shell-watchdog:${TAG}\\012./job.sh`;
  assert.equal(verifyLeader(processes, argv, target), null);
  assert.equal(verifyLeader(processes, `/bin/zsh -c # shell-watchdog:${TAG}\n./job.sh`, target), null, "real newline in ps output");

  // The original exited, another group leader got its pid, the exit event is late.
  assert.match(verifyLeader(processes, "/usr/bin/some-daemon --serve", target), /is not the command/);
  assert.match(verifyLeader(processes, `/bin/zsh -c # shell-watchdog:${TAG}ff\\012x`, target), /is not the command/, "the whole tag");
  assert.match(verifyLeader(processes, `/bin/zsh -c # shell-watchdog:${TAG.replace("0a", "0b")}\\012x`, target), /is not the command/);
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
  assert.equal(verifySurvivors([child], "", entry), null, "leader gone, an old child is left");
  assert.equal(verifySurvivors([{ pid: 4242, pgid: 4242, startedWall: 1_000_000 }, child], argv, entry), null);
  assert.match(verifySurvivors([{ pid: 4242, pgid: 4242, startedWall: 2_500_000 }], "/usr/bin/other", entry), /another process/);
  assert.match(verifySurvivors([{ pid: 5000, pgid: 4242, startedWall: 2_500_000 }], "", entry), /predates/);
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

test("report text is bounded", () => {
  assert.equal(shortCommand(`# shell-watchdog:${TAG}\n# watchdog: report=5m\n./a.sh\n./b.sh`), "./a.sh … (+1 more lines)");
  assert.ok(shortCommand("x".repeat(5000)).length <= 200);
  assert.equal(shortCommand(""), "(empty command)");

  const tail = tailLines(Array.from({ length: 100 }, (_, i) => `line ${i} ${"y".repeat(400)}`).join("\n"), 15);
  assert.ok(tail.length >= 1 && tail.length <= 15);
  assert.ok(tail.every((line) => line.length <= 200));
  assert.ok(tail.join("\n").length <= 1500);
  assert.match(tail.at(-1), /^line 99 /);
  assert.deepEqual(tailLines("a\nb", 0), []);
  assert.deepEqual(tailLines("start\nwaiting\nwaiting\nwaiting\ndone\n", 15), ["start", "waiting (x3)", "done"]);

  const blocks = Array.from({ length: 40 }, (_, i) => ({ id: `sh_${i}`, text: "z".repeat(400) }));
  const message = composeMessage(blocks, ["notice"], "footer");
  assert.ok(message.length <= MESSAGE_CAP + 600);
  assert.match(message, /also due, see the watchdog tool: sh_\d+/);
  assert.ok(message.startsWith("notice"));
  assert.ok(message.endsWith("footer"));
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
