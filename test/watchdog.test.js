import assert from "node:assert/strict";
import { test } from "node:test";
import { addTag, parseOptions } from "../src/core.js";
import { addInstance, beforeCreate, createState, handleEvent, ownerOf, removeInstance, takeLines, tick, toolCall } from "../src/watchdog.js";

const MIN = 60_000;
const TICK = 30_000;
const FIRST_TAG = "0a1b2c3d-1111-2222-3333-000000000001";
const KILL_COMMAND = "# watchdog: kill-silence=2m silence=off\n./job.sh";

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
    readGate: null,
    getGate: null,
    psFails: false,
    argvFails: false,
    readFails: false,
    sendFails: false,
    statCalls: [],
    tags: 0,
  };
  w.newTag = () => `0a1b2c3d-1111-2222-3333-${String(++w.tags).padStart(12, "0")}`;
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
      if (w.readGate) {
        const gate = w.readGate;
        w.readGate = null;
        await gate.promise;
      }
      if (w.readFails) throw Object.assign(new Error("read failed"), { code: "EIO" });
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
    // Like ps: "" for a pid that does not exist.
    async argv(pid) {
      if (w.psGate) await w.psGate.promise;
      if (w.psFails || w.argvFails) throw new Error("ps failed");
      return w.argv.get(pid) ?? "";
    },
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

  /** A shell command is started, the way OpenCode does it: hook first, then the process, then the event. */
  w.shell = (id, { sessionID = "ses_1", pid, dir = "/a", command = "./job.sh", shell = "/bin/zsh" } = {}) => {
    const file = `/out/${id}`;
    w.files.set(file, { ino: pid, data: Buffer.alloc(0) });
    w.alive.add(pid);
    w.groups.add(pid);
    // The hook runs in the instance of the command's location only.
    const event = { command, shell };
    const owner = ownerOf(w.state, { dir, workspace: null });
    if (owner) beforeCreate(w.state, w.io, owner, event, w.newTag);
    w.argv.set(pid, `${shell} +o nomatch -c ${event.command.replace(/\n/g, "\\012")}`);
    w.processes.push({ pid, pgid: pid, startedWall: w.wall });
    w.created(id, { sessionID, pid, dir, command: event.command, shell, file });
    return file;
  };

  /** The bare `shell.created` event, without hook and process. */
  w.created = (id, { sessionID = "ses_1", pid, dir = "/a", command, shell = "/bin/zsh", file = `/out/${id}`, started = w.wall }) => {
    handleEvent(w.state, w.io, {
      type: "shell.created",
      location: { directory: dir },
      data: { info: { id, status: "running", command, shell, file, pid, metadata: { sessionID }, time: { started } } },
    });
  };

  w.print = (id, text) => {
    const entry = w.files.get(`/out/${id}`);
    entry.data = Buffer.concat([entry.data, Buffer.from(text)]);
  };

  /** The shell process ends and OpenCode says so. Its children, if any, stay in the group. */
  w.exit = (id, pid) => {
    w.alive.delete(pid);
    w.argv.delete(pid);
    w.processes = w.processes.filter((proc) => proc.pid !== pid);
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
  w.shell("sh_1", { pid: 100 });
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
  w.shell("sh_1", { pid: 100 });
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
  w.shell("sh_1", { pid: 100 });
  await w.run(a, 5.5 * MIN, () => w.print("sh_1", "waiting for server\n"));
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /still printing, but nothing new for 5m: \d+ repeated lines, all seen before/);
  assert.match(a.sent[0].text, /  waiting for server \(x11\)\n/, "a run of identical lines is one line of the report");
  w.print("sh_1", "server is up\n");
  await w.run(a, 4 * MIN, () => w.print("sh_1", "request served\nserver is up\n"));
  assert.equal(a.sent.length, 1, "new lines ended the stall");
});

test("a busy session gets nothing, and one report when it becomes idle", async () => {
  const { w, a } = await started();
  const session = w.sessions.get("ses_1");
  session.time = { busy: 5, idle: 4 };
  w.shell("sh_1", { pid: 100 });
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
  w.shell("sh_1", { pid: 100 });
  w.shell("sh_2", { pid: 200, command: "./other.sh" });
  await w.run(a, 5 * MIN);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /sh_1: no output[\s\S]*\n\n\[shell-watchdog\] sh_2: no output/);
});

test("an exited command is forgotten and cannot be revived by a late event", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100 });
  await w.run(a, 2 * MIN);
  w.exit("sh_1", 100);
  assert.equal(w.state.shells.size, 0);
  w.alive.add(100);
  w.shell("sh_1", { pid: 100 });
  assert.equal(w.state.shells.size, 0, "tombstone");
  await w.run(a, 10 * MIN);
  assert.equal(a.sent.length, 0);
});

test("a command that died without an exit event is dropped", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100 });
  await w.run(a, TICK);
  w.alive.delete(100);
  await w.run(a, TICK);
  assert.equal(w.state.shells.size, 1, "one miss is not enough");
  await w.run(a, TICK);
  assert.equal(w.state.shells.size, 0);
});

test("commands without a session, ignored ones and '# watchdog: off' are not watched", async () => {
  const { w, a } = await started({ ignore: ["^npm run dev"] });
  w.shell("sh_1", { pid: 100, command: "npm run dev" });
  w.shell("sh_2", { pid: 200, command: "# watchdog: off\n./server.sh" });
  w.shell("sh_3", { pid: 300, sessionID: null });
  assert.equal(w.state.shells.size, 0);
  await w.run(a, 10 * MIN);
  assert.equal(a.sent.length, 0);
});

test("per-command settings: periodic reports without stall reports", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: "# watchdog: report=2m silence=off\n./train.sh" });
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
  w.shell("sh_1", { pid: 100, dir: "/b", command: "# watchdog: kill-runtime=1m\n./job.sh" });
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
  w.shell("sh_1", { pid: 100, dir: "/b" });
  w.shell("sh_2", { pid: 200, dir: "/c" });
  w.alive.delete(100);
  w.instance("/b");
  assert.equal(w.state.shells.size, 0);
  assert.equal(w.state.pending.size, 1);
  await w.run(a, 61 * MIN);
  assert.equal(w.state.pending.size, 0);
});

test("time nobody was watching does not count as silence", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100 });
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

// --- Reading the output ------------------------------------------------------------------------------

test("an output file that cannot be stat'ed is not silence", async () => {
  const { w, a } = await started();
  const file = w.shell("sh_1", { pid: 100 });
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

test("a read that fails after a good stat is not silence, and the bytes are read again", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  const rec = w.state.shells.get("sh_1");
  await w.run(a, MIN);
  w.print("sh_1", "line\n");
  w.readFails = true;
  await w.run(a, 10 * MIN);
  assert.equal(rec.observe, "EIO", "the size is known, the content is not");
  assert.deepEqual([rec.size, rec.offset], [0, 0], "nothing of the failed observation was kept");
  assert.deepEqual(w.signals, [], "kill-silence does not fire on output that cannot be read");

  w.readFails = false;
  await w.run(a, TICK);
  assert.equal(rec.observe, "ok");
  assert.deepEqual([rec.size, rec.offset], [5, 5]);
  await w.run(a, MIN);
  assert.deepEqual(w.signals, [], "silence is counted from the moment the file was readable again");
  await w.run(a, MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
});

test("an observation is dropped when the owner goes away while the output is being read", async () => {
  const w = world();
  const a = w.instance("/a");
  const b = w.instance("/b");
  await tick(w.state, w.io, a);
  w.shell("sh_1", { pid: 100, dir: "/b" });
  const rec = w.state.shells.get("sh_1");
  w.print("sh_1", "one\n");
  w.readGate = deferred();
  const gate = w.readGate;
  w.mono += TICK;
  const running = tick(w.state, w.io, a);
  await settle();
  removeInstance(w.state, b);
  gate.resolve();
  await running;
  assert.deepEqual([rec.offset, rec.memory], [0, null], "nothing was taken into the record");
  assert.equal(rec.episode.tainted, true);

  w.instance("/b");
  await w.run(a, TICK);
  assert.equal(rec.offset, 4, "the next owner reads the same bytes");
});

test("an observation is dropped when the settings changed while the output was being read", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100 });
  const rec = w.state.shells.get("sh_1");
  w.print("sh_1", "one\n");
  w.readGate = deferred();
  const gate = w.readGate;
  w.mono += TICK;
  const running = tick(w.state, w.io, a);
  await settle();
  await toolCall(w.state, w.io, a, { id: "sh_1", loop: "shape" }, "ses_1");
  gate.resolve();
  await running;
  assert.equal(rec.offset, 0);
  await w.run(a, TICK);
  assert.equal(rec.offset, 4);
});

test("output that arrived but could not be taken in is not silence: no kill, no report from the old picture", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: "# watchdog: kill-silence=2m silence=1m\n./job.sh" });
  const rec = w.state.shells.get("sh_1");
  await w.run(a, 1.5 * MIN);
  assert.equal(a.sent.length, 1, "the stall was reported once");
  assert.deepEqual(w.signals, []);

  // New bytes arrive right before the pass that would reach the kill limit, and while they are being
  // read the agent changes an unrelated setting.
  w.print("sh_1", "still alive\n");
  w.readGate = deferred();
  const gate = w.readGate;
  w.mono += TICK;
  w.wall += TICK;
  const running = tick(w.state, w.io, a);
  await settle();
  await toolCall(w.state, w.io, a, { id: "sh_1", report: "30m" }, "ses_1");
  gate.resolve();
  await running;
  assert.equal(rec.fresh, false);
  assert.deepEqual(w.signals, [], "the two minutes of silence were over before this pass, and it must not act on them");
  assert.equal(a.sent.length, 1);

  await w.run(a, TICK);
  assert.equal(rec.offset, 12, "the bytes are taken in by the next pass");
  await w.run(a, MIN);
  assert.deepEqual(w.signals, []);
  await w.run(a, MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]], "two minutes after the output, not before");
});

test("reading output: partial lines wait, a replaced file is read again, a flood is sampled", async () => {
  const { w, a } = await started();
  const file = w.shell("sh_1", { pid: 100 });
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
  assert.equal(rec.offset, 6, "another inode: read from the start");
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

// --- Delivery ----------------------------------------------------------------------------------------

test("session budget: stall wakes are limited, a snoozed check still comes through", async () => {
  const { w, a } = await started({ maxWakes: 2, maxReports: 1 });
  w.shell("sh_1", { pid: 100 });
  await w.run(a, 2 * MIN);
  w.shell("sh_2", { pid: 200 });
  await w.run(a, 2 * MIN);
  w.shell("sh_3", { pid: 300 });
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

  // The window is observed time: a day of ticks frees the budget.
  await w.run(a, 24 * 60 * MIN);
  w.shell("sh_4", { pid: 400 });
  await w.run(a, 5.5 * MIN);
  assert.equal(a.sent.length, 4);
});

test("resume=false: one message waits in the inbox, nothing more until the session moves", async () => {
  const { w, a } = await started({ resume: false });
  w.shell("sh_1", { pid: 100 });
  await w.run(a, 2 * MIN);
  w.shell("sh_2", { pid: 200 });
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

test("resume=false: a notice about a finished command waits as well", async () => {
  const { w, a } = await started({ resume: false });
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  w.processes.push({ pid: 101, pgid: 100, startedWall: w.wall });
  await w.run(a, 2 * MIN);
  assert.equal(a.sent.length, 1, "the command was stopped and the session told");
  w.exit("sh_1", 100);
  await w.run(a, 10 * MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"], [100, "SIGKILL"]]);
  assert.equal(a.sent.length, 1, "the second notice is held back: the first message is still unread");
  const session = w.sessions.get("ses_1");
  session.time = { busy: w.wall, idle: w.wall + 1 };
  await w.run(a, TICK);
  assert.equal(a.sent.length, 2);
  assert.match(a.sent[1].text, /SIGKILL was sent/);

  // Nothing is kept for ever: a day later the session is forgotten.
  await w.run(a, 25 * 60 * MIN);
  assert.equal(w.state.sessions.size, 0);
});

test("a failed send is an attempt, not something to retry every tick", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100 });
  w.sendFails = true;
  await w.run(a, 9 * MIN);
  assert.equal(a.sent.length, 1);
  assert.equal(w.logs.filter((entry) => entry.kind === "send-failed").length, 1);
});

test("archived and deleted sessions", async () => {
  const { w, a } = await started();
  w.session("ses_2");
  w.shell("sh_1", { pid: 100 });
  w.shell("sh_2", { pid: 200, sessionID: "ses_2" });
  w.shell("sh_3", { pid: 300, sessionID: "ses_gone" });
  w.sessions.get("ses_1").time.archived = 5;
  await w.run(a, 6 * MIN);
  assert.deepEqual(a.sent.map((message) => message.sessionID), ["ses_2"], "an archived session is never woken");
  assert.equal(w.state.shells.has("sh_3"), false, "a session that does not exist takes its commands along");

  handleEvent(w.state, w.io, { type: "session.deleted", data: { sessionID: "ses_2" } });
  assert.deepEqual([...w.state.shells.keys()], ["sh_1"]);
});

test("a message never exceeds its size limit, however many commands and notices are due", async () => {
  const { w, a } = await started({ maxWakes: 0 });
  const noisy = `${"ж".repeat(180)}\n`;
  for (let i = 0; i < 30; i++) {
    w.shell(`sh_${i}`, { pid: 1000 + i, command: `./job-${"я".repeat(300)}-${i}.sh` });
    w.print(`sh_${i}`, Array.from({ length: 40 }, (_, n) => `${n} ${noisy}`).join(""));
  }
  await w.run(a, 5.5 * MIN);
  assert.equal(a.sent.length, 1);
  const size = Buffer.byteLength(a.sent[0].text, "utf8");
  assert.ok(size <= 6000, `${size} bytes`);
  assert.match(a.sent[0].text, /Not shown, see the watchdog tool: also due: sh_\d+/);
  assert.doesNotMatch(a.sent[0].text, /�/, "no character was cut in half");
});

// --- Automatic kill ----------------------------------------------------------------------------------

test("kill: a command launched with a limit is tagged, stopped at the limit, and the session is told", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  w.processes.push({ pid: 101, pgid: 100, startedWall: w.wall });
  const rec = w.state.shells.get("sh_1");
  assert.equal(rec.tag, FIRST_TAG);
  assert.equal(w.argv.get(100), `/bin/zsh +o nomatch -c # shell-watchdog:${FIRST_TAG}\\012trap : EXIT\\012# watchdog: kill-silence=2m silence=off\\012./job.sh`);
  assert.equal(rec.command, KILL_COMMAND, "the record keeps the command as it was given");
  assert.equal(rec.settings.killSilence, 2 * MIN);

  await w.run(a, 1.5 * MIN);
  assert.deepEqual(w.signals, []);
  await w.run(a, TICK);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /sh_1 was stopped by the watchdog: no output for 2m, limit kill-silence=2m/);

  // The shell dies, its child ignores SIGTERM. The record is gone, the permission is not.
  w.exit("sh_1", 100);
  assert.equal(w.state.shells.size, 0);
  await w.run(a, TICK);
  assert.deepEqual(w.signals, [[100, "SIGTERM"], [100, "SIGKILL"]]);
  assert.equal(w.state.terminating.size, 0);
  assert.equal(a.sent.length, 2, "the notice is delivered although no command of the session is left");
  assert.match(a.sent[1].text, /still alive after SIGTERM, SIGKILL was sent/);
});

test("kill: a shell that ignores SIGTERM gets SIGKILL while it still is the tagged command", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2.5 * MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"], [100, "SIGKILL"]]);
});

test("kill: a group that went away after SIGTERM is left alone", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  w.exit("sh_1", 100);
  w.groups.delete(100);
  await w.run(a, MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  assert.equal(w.state.terminating.size, 0);
});

test("kill is refused when the pid was reused by another process", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
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

test("kill is refused when the shell replaced itself and the tag left its command line", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: "# watchdog: kill-silence=2m silence=off\nexec ./server" });
  w.argv.set(100, "./server");
  await w.run(a, 3 * MIN);
  assert.deepEqual(w.signals, []);
  assert.match(a.sent[0].text, /NOT killed: process 100 is not the command that was launched/);
});

test("kill is refused when the process table or the command line cannot be read", async () => {
  for (const failure of ["psFails", "argvFails"]) {
    const { w, a } = await started();
    w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
    w[failure] = true;
    await w.run(a, 3 * MIN);
    assert.deepEqual(w.signals, [], failure);
    assert.match(a.sent[0].text, /NOT killed: the process list could not be read/, failure);
  }
});

test("a tag is trusted only when this plugin issued it for this launch", async () => {
  const { w } = await started();
  // Somebody pastes a command that already carries a tag line, e.g. copied from `ps`.
  const pasted = addTag(KILL_COMMAND, "ffffffff-1111-2222-3333-444444444444");
  w.shell("sh_1", { pid: 100, command: pasted });
  const first = w.state.shells.get("sh_1");
  assert.equal(first.tag, FIRST_TAG, "the pasted tag was replaced by a fresh one");
  assert.equal(first.command, KILL_COMMAND);
  assert.equal(w.argv.get(100).match(/shell-watchdog:/g).length, 1);

  // The same text started again is a different command with a different identity.
  w.shell("sh_2", { pid: 200, command: pasted });
  assert.notEqual(w.state.shells.get("sh_2").tag, first.tag);

  // A tag that reaches the registry without having been issued (the hook did not run) is ignored.
  w.created("sh_3", { pid: 300, command: pasted });
  const forged = w.state.shells.get("sh_3");
  assert.equal(forged.tag, null);
  assert.deepEqual([forged.settings.killSilence, forged.settings.killRuntime], [0, 0]);

  // An issued tag is good for one command only.
  w.created("sh_4", { pid: 400, command: addTag(KILL_COMMAND, first.tag) });
  assert.equal(w.state.shells.get("sh_4").tag, null);
});

test("commands without a kill limit are started exactly as they were given", async () => {
  const { w, a } = await started();
  for (const command of ["./job.sh", "# watchdog: report=5m\n./job.sh", "# watchdog: off kill-runtime=1h\n./job.sh"]) {
    const event = { command, shell: "/bin/zsh" };
    beforeCreate(w.state, w.io, a, event, w.newTag);
    assert.equal(event.command, command);
  }
  assert.equal(w.state.issued.size, 0);
});

test("a tag that comes with a command is removed even when the command gets none of its own", async () => {
  const { w, a } = await started();
  const unlimited = "# watchdog: kill-silence=off silence=off\n./job.sh";
  const event = { command: addTag(unlimited, FIRST_TAG), shell: "/bin/zsh" };
  beforeCreate(w.state, w.io, a, event, w.newTag);
  assert.equal(event.command, unlimited);
  assert.equal(w.state.issued.size, 0);
});

test("a relaunch of the old tagged text on a reused pid is never taken for the old command", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  const launched = addTag(KILL_COMMAND, FIRST_TAG); // what `ps` and the list of commands show
  assert.ok(w.argv.get(100).includes(FIRST_TAG));

  // sh_1 ends, its exit event is lost, pid 100 goes to a new command: the same text, copied with its
  // tag, with the limits switched off this time.
  const copied = launched.replace("kill-silence=2m", "kill-silence=off");
  w.shell("sh_2", { pid: 100, command: copied });
  assert.doesNotMatch(w.argv.get(100), /shell-watchdog/, "the old identity did not get into the new argv");
  assert.equal(w.state.shells.get("sh_2").tag, null);
  assert.equal(w.state.shells.has("sh_1"), false, "and the old record went the moment its pid showed up again");

  await w.run(a, 3 * MIN);
  assert.deepEqual(w.signals, [], "nothing of the old command can signal the new process");
  assert.equal(a.sent.length, 0);
});

test("a pid that shows up in a new command ends everything the old command of that pid could do", async () => {
  // The worst case: the old tag does get into the argv of the new process, through a nested shell.
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  const launched = addTag(KILL_COMMAND, FIRST_TAG);
  // sh_1 ends without an exit event; its pid goes to an unwatched command that execs the old text.
  w.shell("sh_2", { pid: 100, command: `# watchdog: off\nexec /bin/sh -c '${launched}'` });
  w.argv.set(100, `/bin/sh -c ${launched.replace(/\n/g, "\\012")}`);
  assert.equal(w.state.shells.size, 0, "sh_2 is not watched, and sh_1 is forgotten");
  await w.run(a, 5 * MIN);
  assert.deepEqual(w.signals, []);

  // The same for a command without a session, which is never watched either.
  w.shell("sh_3", { pid: 300, command: KILL_COMMAND });
  w.shell("sh_4", { pid: 300, sessionID: null, command: "./anything.sh" });
  assert.equal(w.state.shells.has("sh_3"), false);

  // And for a pending SIGKILL: the group it was meant for is gone when its id is in use again.
  w.shell("sh_5", { pid: 500, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.signals, [[500, "SIGTERM"]]);
  assert.equal(w.state.terminating.size, 1);
  w.shell("sh_6", { pid: 500, command: "./next.sh" });
  assert.equal(w.state.terminating.size, 0);
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.signals, [[500, "SIGTERM"]], "no SIGKILL for the group of the new command");

  // A command waiting for its location's instance is dropped the same way.
  w.shell("sh_7", { pid: 700, dir: "/elsewhere" });
  assert.equal(w.state.pending.size, 1);
  w.shell("sh_8", { pid: 700 });
  assert.equal(w.state.pending.size, 0);
  assert.deepEqual([...w.state.shells.keys()], ["sh_6", "sh_8"]);
});

test("an event that arrives late still ends the old command of its pid, and is not watched itself", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  const launched = addTag(KILL_COMMAND, FIRST_TAG);
  await w.run(a, MIN);

  // sh_1 ends without an exit event. Its pid goes to an unwatched command that execs the old text,
  // and the event about that start is held up for six minutes (the machine slept).
  const startedAt = w.wall;
  w.argv.set(100, `/bin/sh -c ${launched.replace(/\n/g, "\\012")}`);
  w.wall += 6 * MIN;
  w.created("sh_2", { pid: 100, command: `# watchdog: off\nexec /bin/sh -c '${launched}'`, started: startedAt });
  assert.equal(w.state.shells.size, 0, "the old record is gone, the late one is not registered");
  assert.equal(w.state.done.has("sh_2"), true);
  await w.run(a, 5 * MIN);
  assert.deepEqual(w.signals, []);

  // The same with a SIGKILL pending for the old group.
  w.shell("sh_3", { pid: 300, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.signals, [[300, "SIGTERM"]]);
  const restartedAt = w.wall;
  w.wall += 6 * MIN;
  w.created("sh_4", { pid: 300, command: "./next.sh", started: restartedAt });
  assert.equal(w.state.terminating.size, 0);
  await w.run(a, MIN);
  assert.deepEqual(w.signals, [[300, "SIGTERM"]]);
});

test("an event about an earlier start of the same pid does not touch the command that has the pid now", async () => {
  const { w, a } = await started();
  // A had the pid first and was never watched (no session); then B got the pid.
  const firstStart = w.wall;
  w.created("sh_a", { pid: 100, sessionID: null, command: "./a.sh" });
  assert.equal(w.state.done.has("sh_a"), true, "an unwatched id is remembered too");
  w.wall += MIN;
  w.shell("sh_b", { pid: 100, command: KILL_COMMAND });
  w.processes.push({ pid: 101, pgid: 100, startedWall: w.wall });

  // A's event comes again: as a duplicate, and as if it had never been seen.
  w.created("sh_a", { pid: 100, sessionID: null, command: "./a.sh", started: firstStart });
  w.state.done.delete("sh_a");
  w.created("sh_a", { pid: 100, sessionID: null, command: "./a.sh", started: firstStart });
  w.created("sh_c", { pid: 100, command: "./c.sh", started: firstStart - MIN });
  assert.deepEqual([...w.state.shells.keys()], ["sh_b"], "B is still watched, and nothing older is registered beside it");
  assert.equal(w.state.done.has("sh_c"), true);

  // B's pending SIGKILL survives such an event as well.
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  w.exit("sh_b", 100);
  w.created("sh_d", { pid: 100, sessionID: null, command: "./d.sh", started: firstStart });
  assert.equal(w.state.terminating.size, 1);
  await w.run(a, TICK);
  assert.deepEqual(w.signals, [[100, "SIGTERM"], [100, "SIGKILL"]]);
});

test("events out of order: a command whose pid already has a later start is not registered at all", async () => {
  for (const next of ["off", "watched"]) {
    const { w, a } = await started();
    // A is launched with a kill limit and gets its tag, but the event about it is held up.
    const first = { command: KILL_COMMAND, shell: "/bin/zsh" };
    beforeCreate(w.state, w.io, a, first, w.newTag);
    const firstStart = w.wall;
    assert.equal(w.state.issued.size, 1);

    // A ends. Ten seconds later its pid belongs to B, which carries A's text in a nested shell, and
    // B's event comes first.
    w.wall += 10_000;
    const nested = `exec /bin/sh -c '${first.command}'`;
    w.shell("sh_b", { pid: 100, command: next === "off" ? `# watchdog: off\n${nested}` : nested });
    w.argv.set(100, `/bin/sh -c ${first.command.replace(/\n/g, "\\012")}`);
    assert.equal(w.state.shells.has("sh_b"), next === "watched");

    // Now A's event arrives, its tag still fresh.
    w.wall += 20_000;
    w.created("sh_a", { pid: 100, command: first.command, started: firstStart });
    assert.equal(w.state.shells.has("sh_a"), false, `${next}: the older start is not registered`);
    assert.equal(w.state.done.has("sh_a"), true);
    assert.equal(w.state.shells.has("sh_b"), next === "watched", "and takes nothing from the newer one");

    await w.run(a, 6 * MIN);
    assert.deepEqual(w.signals, [], `${next}: nobody signals the process of B`);
  }
});

test("a tag is good for a moment only: an event that comes a minute late gets no kill limit", async () => {
  const { w, a } = await started();
  const event = { command: KILL_COMMAND, shell: "/bin/zsh" };
  beforeCreate(w.state, w.io, a, event, w.newTag);
  const startedAt = w.wall;
  w.wall += 61_000;
  w.alive.add(100);
  w.files.set("/out/sh_1", { ino: 100, data: Buffer.alloc(0) });
  w.created("sh_1", { pid: 100, command: event.command, started: startedAt });
  const rec = w.state.shells.get("sh_1");
  assert.equal(rec.tag, null);
  assert.deepEqual([rec.settings.killSilence, rec.settings.killRuntime], [0, 0]);
  assert.match(rec.notes.join("; "), /kill limits/);
  assert.equal(w.state.issued.size, 0);

  // Nor does a command whose start time is unknown.
  const other = { command: KILL_COMMAND, shell: "/bin/zsh" };
  beforeCreate(w.state, w.io, a, other, w.newTag);
  assert.equal(w.state.issued.size, 1);
  handleEvent(w.state, w.io, {
    type: "shell.created",
    location: { directory: "/a" },
    data: { info: { id: "sh_2", status: "running", command: other.command, shell: "/bin/zsh", file: "/out/sh_2", pid: 200, metadata: { sessionID: "ses_1" } } },
  });
  assert.equal(w.state.shells.get("sh_2").tag, null);
  assert.equal(w.state.shells.get("sh_2").settings.killSilence, 0);
  assert.equal(w.state.issued.size, 0, "the tag is spent all the same");
});

test("the memory of pids and tags is bounded", async () => {
  const { w, a } = await started();
  for (let i = 0; i < 5200; i++) w.created(`sh_${i}`, { pid: 10_000 + i, sessionID: null, command: "./x.sh" });
  assert.equal(w.state.pids.size, 5000);
  await w.run(a, 11 * MIN);
  assert.equal(w.state.pids.size, 0);
  assert.equal(w.state.done.size, 0);
});

test("a replayed event about a start long ago neither revives a command nor takes a pid from a live one", async () => {
  const { w, a } = await started();
  w.shell("sh_new", { pid: 100 });
  const long = w.wall;
  w.wall += 20 * MIN; // tombstones of that time have expired by now
  handleEvent(w.state, w.io, {
    type: "shell.created",
    location: { directory: "/a" },
    data: { info: { id: "sh_old", status: "running", command: "./old.sh", shell: "/bin/zsh", file: "/out/sh_old", pid: 100, metadata: { sessionID: "ses_1" }, time: { started: long - 60 * MIN } } },
  });
  assert.deepEqual([...w.state.shells.keys()], ["sh_new"]);
  assert.equal(w.state.pending.size, 0);
  await w.run(a, TICK);
  assert.equal(w.state.shells.get("sh_new").missing, 0);
});

test("a tag further down in a command, or after a -c of its own, proves nothing", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  for (const argv of [
    `/bin/zsh +o nomatch -c echo hi\\012# shell-watchdog:${FIRST_TAG}\\012sleep 600`,
    `/bin/zsh +o nomatch -c sh -c # shell-watchdog:${FIRST_TAG}\\012sleep 600`,
    `/usr/bin/tail -f # shell-watchdog:${FIRST_TAG}`,
  ]) {
    w.argv.set(100, argv);
    const rec = w.state.shells.get("sh_1");
    rec.settings.killSilence = 2 * MIN; // armed again after each refusal
    await w.run(a, 3 * MIN);
    assert.deepEqual(w.signals, [], argv);
  }
});

test("tags that never became a command do not pile up", async () => {
  const { w, a } = await started();
  for (let i = 0; i < 1200; i++) beforeCreate(w.state, w.io, a, { command: KILL_COMMAND, shell: "/bin/zsh" }, w.newTag);
  assert.equal(w.state.issued.size, 1000);
  await w.run(a, 11 * MIN);
  assert.equal(w.state.issued.size, 0);
});

test("kill limits exist only for tagged commands; the tool cannot add one later", async () => {
  const { w, a } = await started({ killRuntime: "1m" });
  // PowerShell reads the directive but cannot carry a tag.
  w.shell("sh_1", { pid: 100, command: "# watchdog: kill-silence=1m\n./job.ps1", shell: "/usr/local/bin/pwsh" });
  const rec = w.state.shells.get("sh_1");
  assert.equal(rec.tag, null);
  assert.deepEqual([rec.settings.killSilence, rec.settings.killRuntime], [0, 0]);
  assert.equal(rec.notes.length, 1);

  const answer = await toolCall(w.state, w.io, a, { id: "sh_1", killRuntime: "5m", report: "1m" }, "ses_1");
  assert.match(answer, /^Nothing was changed: a kill limit cannot be added to a command that was launched without one/);
  assert.equal(rec.settings.report, 0, "the valid part of a rejected call is not applied either");
  assert.equal(rec.rev, 0);
  await w.run(a, 4 * MIN);
  assert.deepEqual(w.signals, []);

  // A command that was launched with a limit can have it changed.
  w.shell("sh_2", { pid: 200, command: KILL_COMMAND });
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_2", killSilence: "10m" }, "ses_1"), /kill-silence=10m/);
});

/** A command at its kill limit, with the pass that would stop it waiting for the process table. */
async function atKillLimit(extraLocation) {
  const w = world();
  const a = w.instance("/a");
  const owner = extraLocation ? w.instance(extraLocation) : a;
  w.session("ses_1");
  await tick(w.state, w.io, a);
  w.shell("sh_1", { pid: 100, dir: owner.dir, command: KILL_COMMAND });
  await w.run(a, 1.5 * MIN);
  w.psGate = deferred();
  const gate = w.psGate;
  w.mono += TICK;
  w.wall += TICK;
  const running = tick(w.state, w.io, a);
  await settle();
  const release = async () => {
    gate.resolve();
    w.psGate = null;
    await running;
  };
  return { w, a, owner, release };
}

test("kill: goes ahead when nothing changed while the process table was read", async () => {
  const { w, release } = await atKillLimit();
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
});

test("kill: withdrawn by the tool while the process table is being read", async () => {
  const { w, a, release } = await atKillLimit();
  await toolCall(w.state, w.io, a, { id: "sh_1", killSilence: "off" }, "ses_1");
  await release();
  assert.deepEqual(w.signals, [], "the limit was switched off during ps");
  assert.equal(w.state.terminating.size, 0);
});

test("kill: no signal when the owner instance went away during ps", async () => {
  const { w, owner, release } = await atKillLimit("/b");
  removeInstance(w.state, owner);
  await release();
  assert.deepEqual(w.signals, []);
  assert.equal(w.state.shells.get("sh_1").settings.killSilence, 2 * MIN, "nothing was decided about the command");
  assert.equal(w.state.notices.size, 0);
});

test("kill: no signal when the command exited during ps", async () => {
  const { w, release } = await atKillLimit();
  w.exit("sh_1", 100);
  await release();
  assert.deepEqual(w.signals, []);
  assert.equal(w.state.terminating.size, 0);
});

test("kill: no signal when the record was replaced during ps", async () => {
  const { w, release } = await atKillLimit();
  w.state.shells.set("sh_1", { ...w.state.shells.get("sh_1") });
  await release();
  assert.deepEqual(w.signals, []);
});

test("kill: a pass that lost its lease during ps sends nothing; the pass that replaced it does", async () => {
  const { w, a, release } = await atKillLimit();
  const stale = w.state.lock;
  w.mono += 10 * MIN; // stuck long enough for the lease to be taken over
  const next = tick(w.state, w.io, a);
  await settle();
  assert.notEqual(w.state.lock, stale);
  await release();
  await next;
  assert.deepEqual(w.signals, [[100, "SIGTERM"]], "exactly one SIGTERM");
  assert.equal(w.state.lock, null);
});

/** A command that got its SIGTERM and whose group is still alive: escalation is one tick away. */
async function afterSigterm(extraLocation) {
  const w = world();
  const a = w.instance("/a");
  const owner = extraLocation ? w.instance(extraLocation) : a;
  w.session("ses_1");
  await tick(w.state, w.io, a);
  w.shell("sh_1", { pid: 100, dir: owner.dir, command: KILL_COMMAND });
  w.processes.push({ pid: 101, pgid: 100, startedWall: w.wall });
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  w.exit("sh_1", 100);
  w.psGate = deferred();
  const gate = w.psGate;
  w.mono += TICK;
  const running = tick(w.state, w.io, a);
  await settle();
  const release = async () => {
    gate.resolve();
    w.psGate = null;
    await running;
  };
  return { w, a, owner, release };
}

test("escalation: the leader is gone, ps cannot show its command line, the old child is still killed", async () => {
  const { w, release } = await afterSigterm();
  w.argvFails = true;
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"], [100, "SIGKILL"]]);
});

test("escalation: a leader that is still there but cannot be checked is not killed", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  w.argvFails = true;
  await w.run(a, TICK);
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  assert.match(a.sent.at(-1).text, /SIGKILL was not sent: process 100 could not be checked/);
  assert.equal(w.state.terminating.size, 0);
});

test("escalation: cancelled by the tool while ps runs", async () => {
  const { w, a, release } = await afterSigterm();
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", off: true }, "ses_1"), /pending SIGKILL was cancelled/);
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
});

test("escalation: switching off the limit that fired cancels it, a broken call does not", async () => {
  const { w, a, release } = await afterSigterm();
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", off: true, silence: "soon" }, "ses_1"), /^Nothing was changed/);
  assert.equal(w.state.terminating.size, 1);
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", killRuntime: "off" }, "ses_1"), /a SIGKILL .* is pending/);
  assert.equal(w.state.terminating.size, 1, "another limit fired, not this one");
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", killSilence: "off" }, "ses_1"), /pending SIGKILL was cancelled/);
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

test("escalation: refused when the pid of the leader belongs to another process", async () => {
  const { w, a, release } = await afterSigterm();
  w.processes.push({ pid: 100, pgid: 100, startedWall: w.wall });
  w.argv.set(100, "/usr/bin/unrelated");
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  await w.run(a, TICK);
  assert.match(a.sent.at(-1).text, /SIGKILL was not sent: pid 100 now belongs to another process/);
});

test("session.deleted cancels a pending escalation", async () => {
  const { w, release } = await afterSigterm();
  handleEvent(w.state, w.io, { type: "session.deleted", data: { sessionID: "ses_1" } });
  await release();
  assert.deepEqual(w.signals, [[100, "SIGTERM"]]);
  assert.equal(w.state.notices.size, 0);
});

// --- Generations -------------------------------------------------------------------------------------

test("a stale pass stops quietly and cannot release the lock of the pass that replaced it", async () => {
  const { w, a } = await started();
  const session = w.sessions.get("ses_1");
  session.time = { busy: 5, idle: 4 };
  w.shell("sh_1", { pid: 100 });
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
  w.shell("sh_2", { pid: 200 });
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
  w.shell("sh_1", { pid: 100 });
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
  w.shell("sh_1", { pid: 100 });
  for (let i = 0; i < 12; i++) {
    w.mono += TICK;
    assert.equal(await tick(w.state, w.io, a), true);
    assert.equal(await tick(w.state, w.io, b), false, "the second timer in the same period is a no-op");
  }
  assert.equal(w.state.shells.get("sh_1").clock, 12 * TICK);
  assert.equal(a.sent.length, 1);
});

// --- Tool --------------------------------------------------------------------------------------------

test("tool: status, changes, and nothing for other sessions", async () => {
  const { w, a } = await started();
  assert.match(await toolCall(w.state, w.io, a, {}, "ses_1"), /No shell command of this session is being watched/);
  w.shell("sh_1", { pid: 100 });
  w.shell("sh_2", { pid: 200, sessionID: "ses_2", command: "./theirs.sh" });
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

  // All or nothing, also for "off".
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", off: true, silence: "BAD" }, "ses_1"), /^Nothing was changed: silence needs a duration/);
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", off: "yes" }, "ses_1"), /^Nothing was changed: off must be true or false/);
  assert.equal(w.state.shells.has("sh_1"), true);

  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", off: true }, "ses_1"), /Stopped watching sh_1/);
  assert.equal(w.state.shells.has("sh_1"), false);
  w.shell("sh_1", { pid: 100 });
  assert.equal(w.state.shells.has("sh_1"), false, "stays off");
});

test("tool: a setting changed while a report is being prepared cancels that report", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100 });
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
