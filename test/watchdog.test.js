import assert from "node:assert/strict";
import { test } from "node:test";
import { addTag, parseOptions } from "../src/core.js";
import { addInstance, createState, handleEvent, removeInstance, takeLines, tick, toolCall } from "../src/watchdog.js";

const MIN = 60_000;
const TICK = 30_000;
const TAG = "0a1b2c3d-1111-2222-3333-444455556666";

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

const settle = () => new Promise((done) => setImmediate(done));

/** A fake machine: clock, output files, processes, sessions. */
function world() {
  const w = {
    state: createState(),
    mono: 0,
    wall: 1_700_000_000_000,
    files: new Map(),
    alive: new Set(),
    groups: new Set(),
    processes: [],
    argv: new Map(),
    signals: [],
    logs: [],
    sessions: new Map(),
    psGate: null,
    statGate: null,
    getGate: null,
    psFails: false,
    sendFails: false,
    statCalls: [],
  };
  w.io = {
    platform: "darwin",
    mono: () => w.mono,
    wall: () => w.wall,
    async stat(file) {
      w.statCalls.push(file);
      if (w.statGate) {
        const gate = w.statGate;
        w.statGate = null;
        await gate.promise;
      }
      const entry = w.files.get(file);
      if (!entry) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      if (entry.error) throw Object.assign(new Error(entry.error), { code: entry.error });
      return { size: entry.data.length, ino: entry.ino };
    },
    async read(file, start, length) {
      return w.files.get(file).data.subarray(start, start + length);
    },
    alive: (pid) => w.alive.has(pid),
    groupAlive: (pgid) => w.groups.has(pgid),
    signalGroup: (pgid, signal) => void w.signals.push([pgid, signal]),
    async processes() {
      if (w.psGate) await w.psGate.promise;
      if (w.psFails) throw new Error("ps failed");
      return w.processes;
    },
    argv: async (pid) => w.argv.get(pid) ?? "",
    log: (entry) => void w.logs.push(entry),
  };

  w.instance = (dir, rawOptions = {}) => {
    const { options, settings } = parseOptions({ tick: "30s", ...rawOptions });
    const sent = [];
    const ctx = {
      session: {
        async get({ sessionID }) {
          if (w.getGate) await w.getGate.promise;
          const session = w.sessions.get(sessionID);
          if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
          return session;
        },
        async synthetic(input) {
          sent.push(input);
          if (w.sendFails) throw new Error("server said no");
        },
      },
    };
    const inst = { ctx, options, settings, dir, workspace: null, disposed: false, sent };
    addInstance(w.state, w.io, inst);
    return inst;
  };

  w.session = (id, time = { busy: 1, idle: 2 }) => {
    const session = { id, time: { ...time } };
    w.sessions.set(id, session);
    return session;
  };

  w.launch = (id, { sessionID = "ses_1", pid, dir = "/a", command = "./job.sh", shell = "/bin/zsh" } = {}) => {
    const file = `/out/${id}`;
    w.files.set(file, { ino: pid, data: Buffer.alloc(0) });
    w.alive.add(pid);
    w.groups.add(pid);
    const tagged = /^# shell-watchdog:/.test(command);
    if (tagged) w.argv.set(pid, `${shell} +o nomatch -c ${command.replace(/\n/g, "\\012")}`);
    w.processes.push({ pid, pgid: pid, startedWall: w.wall });
    handleEvent(w.state, w.io, {
      type: "shell.created",
      location: { directory: dir },
      data: { info: { id, status: "running", command, shell, file, pid, metadata: { sessionID }, time: { started: w.wall } } },
    });
    return file;
  };

  w.print = (id, text) => {
    const entry = w.files.get(`/out/${id}`);
    entry.data = Buffer.concat([entry.data, Buffer.from(text)]);
  };

  w.exit = (id, pid) => {
    w.alive.delete(pid);
    handleEvent(w.state, w.io, { type: "shell.exited", data: { id, exit: 0, status: "exited" } });
  };

  /** Advances time tick by tick; each(i) runs before every tick. */
  w.run = async (inst, ms, each) => {
    for (let passed = 0; passed < ms; passed += TICK) {
      w.mono += TICK;
      w.wall += TICK;
      each?.();
      await tick(w.state, w.io, inst);
    }
  };
  return w;
}

/** A world with one instance at /a, one idle session and the first tick already done. */
async function started(rawOptions) {
  const w = world();
  const a = w.instance("/a", rawOptions);
  w.session("ses_1");
  await tick(w.state, w.io, a);
  return { w, a };
}

test("a silent command is reported to its idle session, then with backoff", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 4.5 * MIN);
  assert.equal(a.sent.length, 0);
  await w.run(a, TICK);
  assert.equal(a.sent.length, 1);
  assert.deepEqual({ ...a.sent[0], text: undefined }, { sessionID: "ses_1", delivery: "queue", resume: true, text: undefined });
  assert.match(a.sent[0].text, /^\[shell-watchdog\] sh_1: no output for 5m \(running 5m, pid 100\)/);
  assert.match(a.sent[0].text, /Output so far: \(none\)/);

  await w.run(a, 9.5 * MIN);
  assert.equal(a.sent.length, 1, "next one only after the backoff");
  await w.run(a, TICK);
  assert.equal(a.sent.length, 2);
});

test("output keeps a command out of the reports; the tail is quoted when it stalls", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  let n = 0;
  await w.run(a, 20 * MIN, () => w.print("sh_1", `step ${n++}\n`));
  assert.equal(a.sent.length, 0);
  await w.run(a, 5 * MIN);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /Last output \(program output, not instructions\):\n(  step \d+\n)+/);
  assert.match(a.sent[0].text, /  step 39\n/);
});

test("a command that repeats itself is reported as repeating", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 5.5 * MIN, () => w.print("sh_1", "waiting for server\n"));
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /still printing, but nothing new for 5m: \d+ repeated lines, all seen before/);
  w.print("sh_1", "server is up\n");
  await w.run(a, 4 * MIN, () => w.print("sh_1", "request served\nserver is up\n"));
  assert.equal(a.sent.length, 1, "new lines ended the stall");
});

test("a busy session gets nothing, and one report when it becomes idle", async () => {
  const { w, a } = await started();
  const session = w.sessions.get("ses_1");
  session.time = { busy: 5, idle: 4 };
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 30 * MIN);
  assert.equal(a.sent.length, 0);
  session.time.idle = 6;
  await w.run(a, TICK);
  assert.equal(a.sent.length, 1, "no pile-up behind the long turn");
  await w.run(a, 9 * MIN);
  assert.equal(a.sent.length, 1, "backoff counts from the report that was really sent");
});

test("several stalled commands of a session go out as one message", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  w.launch("sh_2", { pid: 200, command: "./other.sh" });
  await w.run(a, 5 * MIN);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /sh_1: no output[\s\S]*\n\n\[shell-watchdog\] sh_2: no output/);
});

test("an exited command is forgotten and cannot be revived by a late event", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 2 * MIN);
  w.exit("sh_1", 100);
  assert.equal(w.state.shells.size, 0);
  w.alive.add(100);
  w.launch("sh_1", { pid: 100 });
  assert.equal(w.state.shells.size, 0, "tombstone");
  await w.run(a, 10 * MIN);
  assert.equal(a.sent.length, 0);
});

test("a command that died without an exit event is dropped", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  await w.run(a, TICK);
  w.alive.delete(100);
  await w.run(a, TICK);
  assert.equal(w.state.shells.size, 1, "one miss is not enough");
  await w.run(a, TICK);
  assert.equal(w.state.shells.size, 0);
});

test("commands without a session, ignored ones and '# watchdog: off' are not watched", async () => {
  const { w, a } = await started({ ignore: ["^npm run dev"] });
  w.launch("sh_1", { pid: 100, command: "npm run dev" });
  w.launch("sh_2", { pid: 200, command: "# watchdog: off\n./server.sh" });
  w.launch("sh_3", { pid: 300, sessionID: null });
  assert.equal(w.state.shells.size, 0);
  await w.run(a, 10 * MIN);
  assert.equal(a.sent.length, 0);
});

test("per-command settings: periodic reports without stall reports", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100, command: "# watchdog: report=2m silence=off\n./train.sh" });
  await w.run(a, 7 * MIN);
  assert.equal(a.sent.length, 3);
  assert.match(a.sent[0].text, /sh_1 status: active, last output 2m ago \(running 2m, pid 100\)/);
  assert.match(a.sent[0].text, /\$ \.\/train\.sh/);
  assert.match(a.sent[0].text, /Next status in 2m/);
});

test("only the instance of the command's location acts on it", async () => {
  const w = world();
  const a = w.instance("/a");
  w.session("ses_1");
  await tick(w.state, w.io, a);
  w.launch("sh_1", { pid: 100, dir: "/b", command: "# watchdog: kill-runtime=1m\n./job.sh" });
  assert.equal(w.state.pending.size, 1);
  await w.run(a, 20 * MIN);
  assert.equal(a.sent.length, 0, "location /a never speaks for /b");
  assert.deepEqual(w.statCalls, [], "and never looks at its output");
  assert.deepEqual(w.signals, []);

  const b = w.instance("/b", { silence: "1m" });
  assert.equal(w.state.pending.size, 0);
  const rec = w.state.shells.get("sh_1");
  assert.equal(rec.clock, 0, "the clock starts when the owner appears");
  assert.equal(rec.settings.silence, MIN, "with the owner's options");
  assert.equal(rec.settings.killRuntime, 0, "an untagged command never gets a kill limit");
  await w.run(a, MIN);
  assert.equal(b.sent.length, 1);
  assert.equal(a.sent.length, 0);

  removeInstance(w.state, b);
  await w.run(a, 30 * MIN);
  assert.equal(b.sent.length, 1, "nothing happens without the owner");
});

test("a pending command whose process is gone is not activated; pending ones expire", async () => {
  const w = world();
  const a = w.instance("/a");
  await tick(w.state, w.io, a);
  w.launch("sh_1", { pid: 100, dir: "/b" });
  w.launch("sh_2", { pid: 200, dir: "/c" });
  w.alive.delete(100);
  w.instance("/b");
  assert.equal(w.state.shells.size, 0);
  assert.equal(w.state.pending.size, 1);
  await w.run(a, 61 * MIN);
  assert.equal(w.state.pending.size, 0);
});

test("time nobody was watching does not count as silence", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 2 * MIN);
  w.mono += 8 * 60 * MIN; // the laptop slept
  w.wall += 8 * 60 * MIN;
  await tick(w.state, w.io, a);
  assert.equal(a.sent.length, 0);
  assert.equal(w.state.shells.get("sh_1").clock, 2 * MIN);
  await w.run(a, 2.5 * MIN);
  assert.equal(a.sent.length, 0);
  await w.run(a, TICK);
  assert.equal(a.sent.length, 1);
});

test("an unreadable output file is not silence", async () => {
  const { w, a } = await started();
  const file = w.launch("sh_1", { pid: 100 });
  await w.run(a, MIN);
  const saved = w.files.get(file);
  w.files.set(file, { error: "EACCES" });
  await w.run(a, 20 * MIN);
  assert.equal(a.sent.length, 0);
  assert.equal(w.state.shells.get("sh_1").observe, "EACCES");
  w.files.set(file, saved);
  await w.run(a, 4.5 * MIN);
  assert.equal(a.sent.length, 0, "silence restarts when the file is readable again");
  await w.run(a, MIN);
  assert.equal(a.sent.length, 1);
});

test("reading output: partial lines wait, a replaced file is read again, a flood is sampled", async () => {
  const { w, a } = await started();
  const file = w.launch("sh_1", { pid: 100 });
  const rec = w.state.shells.get("sh_1");
  w.print("sh_1", "one\ntw");
  await w.run(a, TICK);
  assert.equal(rec.offset, 4, "the unfinished line stays unread");
  w.print("sh_1", "o\n");
  await w.run(a, TICK);
  assert.equal(rec.offset, 8);
  assert.equal(rec.memory.exact.size, 2);

  w.files.set(file, { ino: 999, data: Buffer.from("fresh\n") });
  await w.run(a, TICK);
  assert.equal(rec.offset, 6);
  assert.equal(rec.memory.exact.size, 3);

  w.print("sh_1", "x".repeat(99) + "\n".repeat(1) + ("flood line\n".repeat(40_000)));
  await w.run(a, TICK);
  assert.equal(rec.sampled, true);
  assert.equal(rec.offset, w.files.get(file).data.length);
  assert.equal(rec.memory.exact.size, 4, "only the last 256 KB were read");
});

test("takeLines", () => {
  assert.deepEqual(takeLines(Buffer.from("a\nb\nc"), false), { text: "a\nb\n", consumed: 4 });
  assert.deepEqual(takeLines(Buffer.from("no newline yet"), false), { text: "", consumed: 0 });
  assert.deepEqual(takeLines(Buffer.from("10%\r20%\r"), false), { text: "10%\r20%\r", consumed: 8 });
  assert.deepEqual(takeLines(Buffer.from("tail of a line\nwhole\npart"), true), { text: "whole\n", consumed: 21 });
  const long = Buffer.alloc(70_000, 0x2e);
  assert.equal(takeLines(long, false).consumed, 70_000, "a huge line without an end is taken as it is");
  const split = Buffer.from("é\n").subarray(0, 1);
  assert.deepEqual(takeLines(split, false), { text: "", consumed: 0 }, "half a character is never decoded");
});

test("session budget: stall wakes are limited, a snoozed check still comes through", async () => {
  const { w, a } = await started({ maxWakes: 2, maxReports: 1 });
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 2 * MIN);
  w.launch("sh_2", { pid: 200 });
  await w.run(a, 2 * MIN);
  w.launch("sh_3", { pid: 300 });
  await w.run(a, 1.5 * MIN);
  assert.equal(a.sent.length, 1);
  await w.run(a, 2 * MIN);
  assert.equal(a.sent.length, 2);
  assert.match(a.sent[1].text, /last of 2 stall reports allowed for this session in 24h/);
  await w.run(a, 30 * MIN);
  assert.equal(a.sent.length, 2, "the budget is spent: sh_3 stays unreported");

  assert.match(await toolCall(w.state, w.io, a, { id: "sh_3", snooze: "1m" }, "ses_1"), /snoozed, check in 1m/);
  await w.run(a, MIN);
  assert.equal(a.sent.length, 3, "the check the agent asked for is never refused");
  assert.match(a.sent[2].text, /sh_3: no output/);

  w.mono += 0; // the window is observed time: a day of ticks frees the budget
  await w.run(a, 24 * 60 * MIN);
  w.launch("sh_4", { pid: 400 });
  await w.run(a, 5.5 * MIN);
  assert.equal(a.sent.length, 4);
});

test("resume=false: one message waits in the inbox, nothing more until the session moves", async () => {
  const { w, a } = await started({ resume: false });
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 2 * MIN);
  w.launch("sh_2", { pid: 200 });
  await w.run(a, 3 * MIN);
  assert.equal(a.sent.length, 1);
  assert.equal(a.sent[0].resume, false);
  await w.run(a, 10 * MIN);
  assert.equal(a.sent.length, 1);
  const session = w.sessions.get("ses_1");
  session.time = { busy: w.wall, idle: w.wall + 1 };
  await w.run(a, TICK);
  assert.equal(a.sent.length, 2);
});

test("a failed send is an attempt, not something to retry every tick", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  w.sendFails = true;
  await w.run(a, 9 * MIN);
  assert.equal(a.sent.length, 1);
  assert.equal(w.logs.filter((entry) => entry.kind === "send-failed").length, 1);
});

test("archived and deleted sessions", async () => {
  const { w, a } = await started();
  w.session("ses_2");
  w.launch("sh_1", { pid: 100 });
  w.launch("sh_2", { pid: 200, sessionID: "ses_2" });
  w.launch("sh_3", { pid: 300, sessionID: "ses_gone" });
  w.sessions.get("ses_1").time.archived = 5;
  await w.run(a, 6 * MIN);
  assert.deepEqual(a.sent.map((message) => message.sessionID), ["ses_2"], "an archived session is never woken");
  assert.equal(w.state.shells.has("sh_3"), false, "a session that does not exist takes its commands along");

  handleEvent(w.state, w.io, { type: "session.deleted", data: { sessionID: "ses_2" } });
  assert.deepEqual([...w.state.shells.keys()], ["sh_1"]);
});

// --- Automatic kill ---------------------------------------------------------------------------------

const KILL_COMMAND = addTag("# watchdog: kill-silence=2m silence=off\n./job.sh", TAG);

test("kill: a tagged command is stopped at its limit, survivors get SIGKILL, the session is told", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100, command: KILL_COMMAND });
  w.processes.push({ pid: 101, pgid: 100, startedWall: w.wall });
  const rec = w.state.shells.get("sh_1");
  assert.equal(rec.tag, TAG);
  assert.equal(rec.command, "# watchdog: kill-silence=2m silence=off\n./job.sh");
  assert.equal(rec.settings.killSilence, 2 * MIN);

  await w.run(a, 1.5 * MIN);
  assert.deepEqual(w.signals, []);
  await w.run(a, TICK);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /sh_1 was stopped by the watchdog: no output for 2m, limit kill-silence=2m/);

  // The shell dies, its child ignores SIGTERM. The record is gone, the permission is not.
  w.exit("sh_1", 100);
  w.processes = w.processes.filter((proc) => proc.pid !== 100);
  assert.equal(w.state.shells.size, 0);
  await w.run(a, TICK);
  assert.deepEqual(w.signals, [[100, "SIGTERM"], [100, "SIGKILL"]]);
  assert.equal(w.state.terminating.size, 0);
  assert.equal(a.sent.length, 2, "the notice is delivered although no command of the session is left");
  assert.match(a.sent[1].text, /still alive after SIGTERM, SIGKILL was sent/);
});

test("kill: a group that went away after SIGTERM is left alone", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  w.exit("sh_1", 100);
  w.groups.delete(100);
  await w.run(a, MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  assert.equal(w.state.terminating.size, 0);
});

test("kill is refused when the pid was reused by another process", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100, command: KILL_COMMAND });
  // The command exited, another group leader got pid 100, and the exit event never arrived.
  w.argv.set(100, "/usr/local/bin/someone-elses-daemon --serve");
  await w.run(a, 3 * MIN);
  assert.deepEqual(w.signals, [], "no signal of any kind");
  const rec = w.state.shells.get("sh_1");
  assert.deepEqual([rec.settings.killSilence, rec.settings.killRuntime], [0, 0]);
  assert.equal(w.state.terminating.size, 0);
  assert.match(a.sent[0].text, /but was NOT killed: process 100 is not the command that was launched/);
  await w.run(a, 10 * MIN);
  assert.deepEqual(w.signals, []);
});

test("kill is refused when the process table cannot be read", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100, command: KILL_COMMAND });
  w.psFails = true;
  await w.run(a, 3 * MIN);
  assert.deepEqual(w.signals, []);
  assert.match(a.sent[0].text, /NOT killed: the process list could not be read/);
});

test("kill limits exist only for tagged commands; the tool cannot add one later", async () => {
  const { w, a } = await started({ killRuntime: "1m" });
  // The hook did not run for this one (say, an unsupported shell): no tag.
  w.launch("sh_1", { pid: 100, command: "# watchdog: kill-silence=1m\n./job.sh" });
  const rec = w.state.shells.get("sh_1");
  assert.deepEqual([rec.settings.killSilence, rec.settings.killRuntime], [0, 0]);
  assert.equal(rec.notes.length, 1);

  const answer = await toolCall(w.state, w.io, a, { id: "sh_1", killRuntime: "5m", report: "1m" }, "ses_1");
  assert.match(answer, /^Nothing was changed: a kill limit cannot be added to a running command/);
  assert.equal(rec.settings.report, 0, "the valid part of a rejected call is not applied either");
  assert.equal(rec.rev, 0);
  await w.run(a, 4 * MIN);
  assert.deepEqual(w.signals, []);
});

test("kill: withdrawn while the process table is being read", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 1.5 * MIN);
  w.psGate = deferred();
  w.mono += TICK;
  const running = tick(w.state, w.io, a);
  await settle();
  await toolCall(w.state, w.io, a, { id: "sh_1", killSilence: "off" }, "ses_1");
  w.psGate.resolve();
  w.psGate = null;
  await running;
  assert.deepEqual(w.signals, [], "the limit was switched off during ps");
  assert.equal(w.state.terminating.size, 0);
});

/** A command that got its SIGTERM and whose group is still alive: escalation is one tick away. */
async function afterSigterm(extraLocation) {
  const w = world();
  const a = w.instance("/a");
  const owner = extraLocation ? w.instance(extraLocation) : a;
  w.session("ses_1");
  await tick(w.state, w.io, a);
  w.launch("sh_1", { pid: 100, dir: owner.dir, command: KILL_COMMAND });
  w.processes.push({ pid: 101, pgid: 100, startedWall: w.wall });
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  w.exit("sh_1", 100);
  w.processes = w.processes.filter((proc) => proc.pid !== 100);
  w.psGate = deferred();
  w.mono += TICK;
  const running = tick(w.state, w.io, a);
  await settle();
  const release = async () => {
    w.psGate.resolve();
    w.psGate = null;
    await running;
  };
  return { w, a, owner, release };
}

test("escalation: cancelled by the tool while ps runs", async () => {
  const { w, a, release } = await afterSigterm();
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", off: true }, "ses_1"), /pending SIGKILL was cancelled/);
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
});

test("escalation: a replaced permission entry does not authorise the old pass", async () => {
  const { w, release } = await afterSigterm();
  const entry = w.state.terminating.get("sh_1");
  w.state.terminating.set("sh_1", { ...entry });
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
});

test("escalation: no signal when the owner instance is gone", async () => {
  const { w, owner, release } = await afterSigterm("/b");
  removeInstance(w.state, owner);
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
});

test("escalation: no signal for a pass that lost its lease", async () => {
  const { w, a, release } = await afterSigterm();
  w.mono += 10 * MIN; // the pass is stuck in ps long enough for its lease to go stale
  const next = tick(w.state, w.io, a);
  await settle();
  await release();
  await next;
  const kills = w.signals.filter(([, signal]) => signal === "SIGKILL");
  assert.equal(kills.length, 1, "exactly one pass may escalate");
  assert.equal(w.state.lock, null);
});

test("escalation: refused when the group id was taken over by younger processes", async () => {
  const { w, a, release } = await afterSigterm();
  w.processes = [{ pid: 100, pgid: 100, startedWall: w.wall + 1000 }];
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  await w.run(a, TICK);
  assert.match(a.sent.at(-1).text, /SIGKILL was not sent: no process of group 100 predates the SIGTERM/);
});

test("session.deleted cancels a pending escalation", async () => {
  const { w, release } = await afterSigterm();
  handleEvent(w.state, w.io, { type: "session.deleted", data: { sessionID: "ses_1" } });
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  assert.equal(w.state.notices.size, 0);
});

// --- Generations ------------------------------------------------------------------------------------

test("a stale pass stops quietly and cannot release the lock of the pass that replaced it", async () => {
  const { w, a } = await started();
  const session = w.sessions.get("ses_1");
  session.time = { busy: 5, idle: 4 };
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 6 * MIN);
  session.time.idle = 6;

  w.statGate = deferred();
  const stuck = w.statGate;
  w.mono += TICK;
  const first = tick(w.state, w.io, a);
  await settle();
  const lease = w.state.lock;
  assert.ok(lease);

  w.mono += 5 * MIN;
  assert.equal(await tick(w.state, w.io, a), true, "the stale lease was replaced");
  assert.equal(a.sent.length, 1);

  w.getGate = deferred();
  w.launch("sh_2", { pid: 200 });
  await w.run(a, TICK); // nothing due for sh_2 yet, the pass finishes
  w.getGate.resolve();
  w.getGate = null;

  // A third pass holds the lock while the first one finally wakes up.
  w.statGate = deferred();
  const holding = w.statGate;
  w.mono += TICK;
  const third = tick(w.state, w.io, a);
  await settle();
  const current = w.state.lock;
  assert.ok(current && current !== lease);
  stuck.resolve();
  await first;
  assert.equal(w.state.lock, current, "the first pass did not release somebody else's lease");
  assert.equal(a.sent.length, 1, "and sent nothing");
  holding.resolve();
  await third;
  assert.equal(w.state.lock, null);
});

test("a disposed instance does nothing; another one takes over the ticking", async () => {
  const w = world();
  const first = w.instance("/a");
  w.session("ses_1");
  await tick(w.state, w.io, first);
  w.launch("sh_1", { pid: 100 });
  await w.run(first, 2 * MIN);
  removeInstance(w.state, first);
  w.mono += TICK;
  assert.equal(await tick(w.state, w.io, first), false);
  const second = w.instance("/a");
  await w.run(second, 3 * MIN);
  assert.equal(first.sent.length, 0);
  assert.equal(second.sent.length, 1, "the reloaded instance carries on with the same record");
});

test("ticks from several instances do not double the work", async () => {
  const w = world();
  const a = w.instance("/a");
  const b = w.instance("/b");
  w.session("ses_1");
  await tick(w.state, w.io, a);
  w.launch("sh_1", { pid: 100 });
  for (let i = 0; i < 12; i++) {
    w.mono += TICK;
    assert.equal(await tick(w.state, w.io, a), true);
    assert.equal(await tick(w.state, w.io, b), false, "the second timer in the same period is a no-op");
  }
  assert.equal(w.state.shells.get("sh_1").clock, 12 * TICK);
  assert.equal(a.sent.length, 1);
});

// --- Tool ------------------------------------------------------------------------------------------

test("tool: status, changes, and nothing for other sessions", async () => {
  const { w, a } = await started();
  assert.match(await toolCall(w.state, w.io, a, {}, "ses_1"), /No shell command of this session is being watched/);
  w.launch("sh_1", { pid: 100 });
  w.launch("sh_2", { pid: 200, sessionID: "ses_2", command: "./theirs.sh" });
  await w.run(a, MIN);

  const list = await toolCall(w.state, w.io, a, {}, "ses_1");
  assert.match(list, /^sh_1: active, last output 1m ago \(running 1m, pid 100\)/);
  assert.doesNotMatch(list, /sh_2|theirs/);
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_2" }, "ses_1"), /sh_2 is not a watched command of this session/);
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_2", off: true }, "ses_1"), /not a watched command/);
  assert.equal(w.state.shells.has("sh_2"), true);

  const changed = await toolCall(w.state, w.io, a, { id: "sh_1", report: "5m", silence: "off", "kill-silence": null }, "ses_1");
  assert.match(changed, /settings: silence=off loop=exact report=5m/);
  const rec = w.state.shells.get("sh_1");
  assert.equal(rec.rev, 1);

  const rejected = await toolCall(w.state, w.io, a, { id: "sh_1", report: "whenever", loop: "shape", bogus: 1 }, "ses_1");
  assert.match(rejected, /^Nothing was changed: unknown field "bogus"; report needs a duration/);
  assert.equal(rec.settings.loop, "exact");
  assert.equal(rec.rev, 1);

  assert.match(await toolCall(w.state, w.io, a, { silence: "1m" }, "ses_1"), /^Nothing was changed: give the id/);
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", off: true }, "ses_1"), /Stopped watching sh_1/);
  assert.equal(w.state.shells.has("sh_1"), false);
  w.launch("sh_1", { pid: 100 });
  assert.equal(w.state.shells.has("sh_1"), false, "stays off");
});

test("tool: a setting changed while a report is being prepared cancels that report", async () => {
  const { w, a } = await started();
  w.launch("sh_1", { pid: 100 });
  await w.run(a, 4.5 * MIN);
  w.getGate = deferred();
  w.mono += TICK;
  const running = tick(w.state, w.io, a);
  await settle();
  await toolCall(w.state, w.io, a, { id: "sh_1", silence: "off" }, "ses_1");
  w.getGate.resolve();
  w.getGate = null;
  await running;
  assert.equal(a.sent.length, 0);
});
