import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_ENV, addTag, guardLine, parseOptions, splitTag } from "../src/core.js";
import { addInstance, beforeCreate, createState, handleEvent, ownerOf, removeInstance, takeLines, tick, toolCall } from "../src/watchdog.js";

const MIN = 60_000;
const TICK = 30_000;
const CLAIMS = "/claims";
const FIRST_TAG = "0a1b2c3d-1111-2222-3333-000000000001";
const FIRST_CLAIM = `${CLAIMS}/${FIRST_TAG}`;
const KILL_COMMAND = "# watchdog: kill-silence=2m silence=off\n./job.sh";

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

const settle = () => new Promise((done) => setImmediate(done));

/** A fake machine: clock, output files, live pids, the claims of guards, sessions. */
function world() {
  const w = {
    state: createState(),
    mono: 0,
    wall: 1_700_000_000_000,
    files: new Map(),
    alive: new Set(),
    claims: new Map(), // claim -> { pid, stop }: the claims guards have made, and whether they were told to stop
    stops: [], // the claims whose guards were told to stop, in order
    cancelled: [],
    dropped: [],
    logs: [],
    sessions: new Map(),
    statGate: null,
    readGate: null,
    stopGate: null,
    cancelGate: null,
    cancelFails: false,
    getGate: null,
    readFails: false,
    claimFails: false,
    stopFails: false,
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
    async readClaim(claim) {
      if (w.claimFails) throw Object.assign(new Error("cannot read"), { code: "EACCES" });
      return w.claims.get(claim)?.pid ?? null;
    },
    async requestStop(claim) {
      if (w.stopGate) {
        const gate = w.stopGate;
        w.stopGate = null;
        await gate.promise;
      }
      if (w.stopFails) throw Object.assign(new Error("cannot write"), { code: "EIO" });
      const made = w.claims.get(claim);
      if (!made) throw Object.assign(new Error("no such claim"), { code: "ENOENT" });
      made.stop = true;
      w.stops.push(claim);
    },
    async cancelStop(claim) {
      if (w.cancelGate) {
        const gate = w.cancelGate;
        w.cancelGate = null;
        await gate.promise;
      }
      if (w.cancelFails) throw Object.assign(new Error("cannot remove"), { code: "EIO" });
      if (w.claims.has(claim)) w.claims.get(claim).stop = false;
      w.cancelled.push(claim);
    },
    async dropClaim(claim) {
      w.claims.delete(claim);
      w.dropped.push(claim);
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
    const inst = { ctx, options, settings, dir, workspace: null, claims: CLAIMS, disposed: false, sent };
    addInstance(w.state, w.io, inst);
    return inst;
  };

  w.session = (id, time = { busy: 1, idle: 2 }) => {
    const session = { id, time: { ...time } };
    w.sessions.set(id, session);
    return session;
  };

  /**
   * A shell command is started, the way OpenCode does it: hook first, then the process, then the
   * event. A command that was given a guard has its claim made by then, as the real guard does when
   * it starts (guard: false leaves that out). The claim is what the hook put into the environment.
   */
  w.shell = (id, { sessionID = "ses_1", pid, dir = "/a", command = "./job.sh", shell = "/bin/zsh", guard = true } = {}) => {
    const file = `/out/${id}`;
    w.files.set(file, { ino: pid, data: Buffer.alloc(0) });
    w.alive.add(pid);
    // The hook runs in the instance of the command's location only.
    const event = { command, shell, env: { PATH: "/usr/bin:/bin" } };
    const owner = ownerOf(w.state, { dir, workspace: null });
    if (owner) beforeCreate(w.state, w.io, owner, event, w.newTag);
    const claim = event.env[CLAIM_ENV];
    if (claim && guard && !w.claims.has(claim)) w.claims.set(claim, { pid: String(pid), stop: false });
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

  /** The shell process ends and OpenCode says so. */
  w.exit = (id, pid) => {
    w.alive.delete(pid);
    handleEvent(w.state, w.io, { type: "shell.exited", data: { id, exit: 0, status: "exited" } });
  };

  w.advance = (ms) => {
    w.mono = w.mono + ms;
    w.wall = w.wall + ms;
  };

  /** Advances time tick by tick; each(i) runs before every tick. */
  w.run = async (inst, ms, each) => {
    for (let passed = 0; passed < ms; passed += TICK) {
      w.advance(TICK);
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
  assert.match(a.sent[0].text, /sh_1 status: active, no output yet \(running 2m, pid 100\)/);
  assert.match(a.sent[0].text, /\$ \.\/train\.sh/);
  assert.match(a.sent[0].text, /Next status in 2m/);
});

test("per-command settings below a first line that names the job", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: "# train the ranking model\n# watchdog: report=2m silence=off\n./train.sh" });
  w.shell("sh_2", { pid: 200, command: "# local preview server\n# watchdog: off\nnpm run dev" });
  w.shell("sh_3", { pid: 300, command: "./plain.sh" });
  assert.deepEqual([...w.state.shells.keys()], ["sh_1", "sh_3"]);
  assert.deepEqual([w.state.shells.get("sh_1").directed, w.state.shells.get("sh_3").directed], [true, false]);
  await w.run(a, 2 * MIN, () => w.print("sh_3", "tick\n" + Math.random() + "\n"));
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /sh_1 status: active, no output yet \(running 2m, pid 100\)\.\n\$ # train the ranking model … \(\+1 more lines\)\n/);
  assert.doesNotMatch(a.sent[0].text, /sh_3/);
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
  assert.deepEqual(w.stops, []);

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
  w.advance(8 * 60 * MIN); // the laptop slept
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
  assert.deepEqual(w.stops, [], "kill-silence does not fire on output that cannot be read");

  w.readFails = false;
  await w.run(a, TICK);
  assert.equal(rec.observe, "ok");
  assert.deepEqual([rec.size, rec.offset], [5, 5]);
  await w.run(a, MIN);
  assert.deepEqual(w.stops, [], "silence is counted from the moment the file was readable again");
  await w.run(a, MIN);
  assert.deepEqual(w.stops, [FIRST_CLAIM]);
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
  w.advance(TICK);
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
  w.advance(TICK);
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
  assert.deepEqual(w.stops, []);

  // New bytes arrive right before the pass that would reach the kill limit, and while they are being
  // read the agent changes an unrelated setting.
  w.print("sh_1", "still alive\n");
  w.readGate = deferred();
  const gate = w.readGate;
  w.advance(TICK);
  const running = tick(w.state, w.io, a);
  await settle();
  await toolCall(w.state, w.io, a, { id: "sh_1", report: "30m" }, "ses_1");
  gate.resolve();
  await running;
  assert.equal(rec.fresh, false);
  assert.deepEqual(w.stops, [], "the two minutes of silence were over before this pass, and it must not act on them");
  assert.equal(a.sent.length, 1);

  await w.run(a, TICK);
  assert.equal(rec.offset, 12, "the bytes are taken in by the next pass");
  await w.run(a, MIN);
  assert.deepEqual(w.stops, []);
  await w.run(a, MIN);
  assert.deepEqual(w.stops, [FIRST_CLAIM], "two minutes after the output, not before");
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

test("resume=false: a second notice waits as well", async () => {
  const { w, a } = await started({ resume: false });
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  assert.equal(a.sent.length, 1, "the command was told to stop and the session told");
  await w.run(a, 10 * MIN);
  assert.equal(a.sent.length, 1, "the notice that it is still running is held back: the first message is still unread");
  const session = w.sessions.get("ses_1");
  session.time = { busy: w.wall, idle: w.wall + 1 };
  await w.run(a, TICK);
  assert.equal(a.sent.length, 2);
  assert.match(a.sent[1].text, /still running/);

  // Nothing is kept for ever: a day after the command ended the session is forgotten.
  w.exit("sh_1", 100);
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
//
// The watchdog signals nothing. A command with a kill limit runs a guard that has made a claim; the
// watchdog tells that guard to stop the command, and the guard stops its own process group. What the
// guard itself does is checked against real shells in io.test.js.

test("kill: a command launched with a limit gets a guard, which is told to stop it at the limit", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  const rec = w.state.shells.get("sh_1");
  assert.deepEqual([rec.tag, rec.claim], [FIRST_TAG, FIRST_CLAIM]);
  assert.equal(rec.command, KILL_COMMAND, "the record keeps the command as it was given");
  assert.equal(rec.settings.killSilence, 2 * MIN);
  assert.equal(rec.bound, false, "no limit is in force before the guard was seen");
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1" }, "ses_1"), /kill limits not in force yet: waiting for the guard/);

  await w.run(a, TICK);
  assert.equal(rec.bound, true);
  await w.run(a, MIN);
  assert.deepEqual(w.stops, []);
  await w.run(a, TICK);
  assert.deepEqual(w.stops, [FIRST_CLAIM], "the guard that made the claim of this launch, and nobody else");
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /sh_1 is being stopped by the watchdog: no output for 2m, limit kill-silence=2m\. Its process group gets SIGTERM/);
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1" }, "ses_1"), /told to stop by the watchdog/);

  // The guard does its work, the command ends; a minute later its claim is cleared away.
  w.exit("sh_1", 100);
  await w.run(a, TICK);
  assert.deepEqual(w.dropped, [], "not at once: a stop that was just asked for must still be found");
  await w.run(a, MIN);
  assert.deepEqual(w.dropped, [FIRST_CLAIM]);
  assert.deepEqual(w.stops, [FIRST_CLAIM], "asked once");
  assert.equal(a.sent.length, 1);
});

test("kill: what a launch with a limit gets: two lines below its opening comments, and the claim in its environment", async () => {
  const { w, a } = await started();
  const event = { command: KILL_COMMAND, shell: "/bin/zsh", env: { PATH: "/bin", [CLAIM_ENV]: "/somebody/else" } };
  beforeCreate(w.state, w.io, a, event, w.newTag);
  assert.equal(event.command, `# watchdog: kill-silence=2m silence=off\n# shell-watchdog:${FIRST_TAG}\n${guardLine()}\n./job.sh`);
  assert.equal(event.command, addTag(KILL_COMMAND, FIRST_TAG));
  assert.deepEqual(splitTag(event.command), { tag: FIRST_TAG, command: KILL_COMMAND });
  assert.deepEqual(event.env, { PATH: "/bin", [CLAIM_ENV]: FIRST_CLAIM }, "the claim of this launch, not one that came in");
  assert.doesNotMatch(event.command, /claims/, "the text says nothing about where the claim is");

  // A launch without a limit gets nothing, and loses a claim that came in with its environment.
  const plain = { command: "./job.sh", shell: "/bin/zsh", env: { PATH: "/bin", [CLAIM_ENV]: FIRST_CLAIM } };
  beforeCreate(w.state, w.io, a, plain, w.newTag);
  assert.deepEqual(plain, { command: "./job.sh", shell: "/bin/zsh", env: { PATH: "/bin" } });

  // Without an environment to put the claim into, there is no guard.
  const bare = { command: KILL_COMMAND, shell: "/bin/zsh" };
  beforeCreate(w.state, w.io, a, bare, w.newTag);
  assert.deepEqual(bare, { command: KILL_COMMAND, shell: "/bin/zsh" });
});

test("kill: a command that opens with its name keeps it as the first line, and its limit works the same", async () => {
  const { w, a } = await started();
  const command = "# nightly build\n# watchdog: kill-runtime=3m silence=off\n./job.sh";
  const event = { command, shell: "/bin/zsh", env: { PATH: "/bin" } };
  beforeCreate(w.state, w.io, a, event, w.newTag);
  assert.deepEqual(event.command.split("\n"), ["# nightly build", "# watchdog: kill-runtime=3m silence=off", `# shell-watchdog:${FIRST_TAG}`, guardLine(), "./job.sh"]);
  w.state.issued.clear();
  w.tags = 0;

  w.shell("sh_1", { pid: 100, command });
  const rec = w.state.shells.get("sh_1");
  assert.deepEqual([rec.command, rec.tag, rec.claim, rec.settings.killRuntime, rec.directed], [command, FIRST_TAG, FIRST_CLAIM, 3 * MIN, true]);
  let n = 0;
  await w.run(a, 2.5 * MIN, () => w.print("sh_1", `step ${n++}\n`));
  assert.deepEqual([rec.bound, w.stops.length], [true, 0]);
  await w.run(a, MIN, () => w.print("sh_1", `step ${n++}\n`));
  assert.deepEqual(w.stops, [FIRST_CLAIM]);
  assert.match(a.sent[0].text, /sh_1 is being stopped by the watchdog: ran for 3m, limit kill-runtime=3m\.[^\n]*\n\$ # nightly build … \(\+1 more lines\)$/);
});

test("kill: a limit by runtime, and limits changed through the tool", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: "# watchdog: kill-runtime=3m silence=off\n./job.sh" });
  let n = 0;
  await w.run(a, 2 * MIN, () => w.print("sh_1", `step ${n++}\n`));
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", killRuntime: "5m" }, "ses_1"), /kill-runtime=5m/);
  await w.run(a, 2.5 * MIN, () => w.print("sh_1", `step ${n++}\n`));
  assert.deepEqual(w.stops, []);
  await w.run(a, TICK, () => w.print("sh_1", `step ${n++}\n`));
  assert.deepEqual(w.stops, [FIRST_CLAIM]);
  assert.match(a.sent[0].text, /ran for 5m, limit kill-runtime=5m/);
});

test("kill: the session is told when a command that was told to stop is still running", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  assert.equal(a.sent.length, 1);
  await w.run(a, TICK);
  assert.equal(a.sent.length, 2);
  assert.match(a.sent[1].text, /sh_1 was told to stop 30s ago and is still running \(pid 100\)\. The watchdog does nothing more about it/);
  await w.run(a, 20 * MIN);
  assert.equal(a.sent.length, 2, "said once");
  assert.deepEqual(w.stops, [FIRST_CLAIM]);
});

test("a kill limit comes into force only when the guard of this very shell has made the claim", async () => {
  // The guard never started (it found itself outside the command's group, or was killed at once).
  const none = await started();
  none.w.shell("sh_1", { pid: 100, command: KILL_COMMAND, guard: false });
  await none.w.run(none.a, TICK);
  assert.equal(none.a.sent.length, 0, "one more pass is given to a slow start");
  await none.w.run(none.a, TICK);
  assert.match(none.a.sent[0].text, /sh_1: automatic kill is off for this command, because its guard did not start/);
  const rec = none.w.state.shells.get("sh_1");
  assert.deepEqual([rec.tag, rec.claim, rec.bound, rec.settings.killSilence], [null, null, false, 0]);
  assert.deepEqual(rec.notes, ["kill limits (its guard did not start)"]);
  // Somebody makes the claim later: too late, nothing is ever asked of it.
  none.w.claims.set(FIRST_CLAIM, { pid: "100", stop: false });
  await none.w.run(none.a, 10 * MIN);
  assert.deepEqual(none.w.stops, []);

  // The claim was made by the guard of another shell.
  const other = await started();
  other.w.claims.set(FIRST_CLAIM, { pid: "4242", stop: false });
  other.w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await other.w.run(other.a, TICK);
  assert.match(other.a.sent[0].text, /automatic kill is off for this command, because its claim was made by another process/);
  await other.w.run(other.a, 10 * MIN);
  assert.deepEqual(other.w.stops, [], "the other guard is never told to stop anything");

  // A guard that needs a moment: seen on the second pass.
  const slow = await started();
  slow.w.shell("sh_1", { pid: 100, command: KILL_COMMAND, guard: false });
  await slow.w.run(slow.a, TICK);
  slow.w.claims.set(FIRST_CLAIM, { pid: "100", stop: false });
  await slow.w.run(slow.a, 1.5 * MIN);
  assert.deepEqual(slow.w.stops, [FIRST_CLAIM]);

  // The claim file is there and still empty (its guard is between creating and writing it): not
  // yet a claim, and not somebody else's either.
  const empty = await started();
  empty.w.claims.set(FIRST_CLAIM, { pid: "", stop: false });
  empty.w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await empty.w.run(empty.a, TICK);
  const half = empty.w.state.shells.get("sh_1");
  assert.deepEqual([half.bound, half.claim, half.settings.killSilence > 0], [false, FIRST_CLAIM, true]);
  assert.equal(empty.a.sent.length, 0);
  empty.w.claims.set(FIRST_CLAIM, { pid: "100", stop: false });
  await empty.w.run(empty.a, TICK);
  assert.equal(half.bound, true);
  await empty.w.run(empty.a, 1.5 * MIN);
  assert.deepEqual(empty.w.stops, [FIRST_CLAIM]);

  // A claims directory that cannot be read counts as a guard that did not start.
  const unreadable = await started();
  unreadable.w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  unreadable.w.claimFails = true;
  await unreadable.w.run(unreadable.a, MIN);
  assert.match(unreadable.a.sent[0].text, /because its guard did not start/);
  unreadable.w.claimFails = false;
  await unreadable.w.run(unreadable.a, 10 * MIN);
  assert.deepEqual(unreadable.w.stops, []);
});

test("kill: when the stop cannot be requested, the session is told and the limit is off", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, TICK);
  w.stopFails = true;
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.stops, []);
  assert.match(a.sent[0].text, /sh_1 reached its kill limit \(no output for 2m, limit kill-silence=2m\) but was NOT stopped: the stop could not be requested \(EIO\)/);
  const rec = w.state.shells.get("sh_1");
  assert.deepEqual([rec.settings.killSilence, rec.killed], [0, null]);
  w.stopFails = false;
  await w.run(a, 10 * MIN);
  assert.deepEqual(w.stops, []);

  // The claim is gone (somebody cleaned the directory): same thing.
  const gone = await started();
  gone.w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await gone.w.run(gone.a, TICK);
  gone.w.claims.clear();
  await gone.w.run(gone.a, 2 * MIN);
  assert.match(gone.a.sent[0].text, /NOT stopped: the stop could not be requested \(ENOENT\)/);
});

/** A command at its kill limit, with the write that tells its guard to stop held up. */
async function atKillLimit(extraLocation) {
  const w = world();
  const a = w.instance("/a");
  const owner = extraLocation ? w.instance(extraLocation) : a;
  w.session("ses_1");
  await tick(w.state, w.io, a);
  w.shell("sh_1", { pid: 100, dir: owner.dir, command: KILL_COMMAND });
  await w.run(a, 1.5 * MIN);
  w.stopGate = deferred();
  const gate = w.stopGate;
  w.advance(TICK);
  const running = tick(w.state, w.io, a);
  await settle();
  const release = async () => {
    gate.resolve();
    await running;
    await settle();
  };
  return { w, a, owner, release };
}

test("kill: the decision is recorded before the stop is written, and carried out once", async () => {
  const { w, a, release } = await atKillLimit();
  const rec = w.state.shells.get("sh_1");
  assert.equal(rec.killed.written, false, "decided, not yet done");
  await release();
  assert.deepEqual(w.stops, [FIRST_CLAIM]);
  assert.deepEqual(w.cancelled, []);
  assert.equal(rec.killed.written, true);
  assert.equal(a.sent.length, 1);
});

test("kill: the stop file ends up saying what the record says, whoever writes last", async () => {
  // The agent switches the limit off while the stop is being written: it is taken back afterwards.
  const off = await atKillLimit();
  const answer = toolCall(off.w.state, off.w.io, off.a, { id: "sh_1", killSilence: "off" }, "ses_1");
  await settle();
  await off.release();
  assert.match(await answer, /The stop that was asked for is taken back/);
  assert.equal(off.w.claims.get(FIRST_CLAIM).stop, false, "written, then removed: in that order");
  assert.equal(off.w.state.shells.get("sh_1").killed, null);
  assert.equal(off.a.sent.length, 0, "nothing was done, nothing is said");
  await off.w.run(off.a, 10 * MIN);
  assert.equal(off.w.claims.get(FIRST_CLAIM).stop, false, "and it is not asked for again");

  // The pass that asked lost its lease meanwhile; the limit was switched off under the next lease.
  const stale = await atKillLimit();
  stale.w.advance(10 * MIN);
  const next = tick(stale.w.state, stale.w.io, stale.a);
  await settle();
  const told = toolCall(stale.w.state, stale.w.io, stale.a, { id: "sh_1", killSilence: "off" }, "ses_1");
  await settle();
  await stale.release();
  await next;
  await told;
  await settle();
  assert.equal(stale.w.claims.get(FIRST_CLAIM).stop, false, "the late writer leaves no stop behind");
  assert.equal(stale.w.state.shells.get("sh_1").killed, null);

  // A stop is taken back, the taking back is held up, and meanwhile another limit fires: the two are
  // carried out in the order they were asked for, so the new stop is what remains.
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  assert.equal(w.claims.get(FIRST_CLAIM).stop, true);
  w.cancelGate = deferred();
  const gate = w.cancelGate;
  const takingBack = toolCall(w.state, w.io, a, { id: "sh_1", killSilence: "off" }, "ses_1");
  await settle();
  await toolCall(w.state, w.io, a, { id: "sh_1", killRuntime: "1m" }, "ses_1");
  w.advance(TICK);
  const pass = tick(w.state, w.io, a);
  await settle();
  assert.notEqual(w.state.shells.get("sh_1").killed, null, "the runtime limit has fired");
  gate.resolve();
  await pass;
  await takingBack;
  await settle();
  assert.deepEqual(w.cancelled, [FIRST_CLAIM]);
  assert.deepEqual(w.stops, [FIRST_CLAIM, FIRST_CLAIM], "written, taken back, written again");
  assert.equal(w.claims.get(FIRST_CLAIM).stop, true, "the late cancellation did not remove the new stop");
});

test("kill: a stop that cannot be taken back is said to be still there, and taken back as soon as it can be", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  assert.equal(w.claims.get(FIRST_CLAIM).stop, true);

  w.cancelFails = true;
  const answer = await toolCall(w.state, w.io, a, { id: "sh_1", killSilence: "off" }, "ses_1");
  assert.match(answer, /could NOT be taken back yet \(EIO\): the command may still be stopped\. The watchdog keeps trying\./);
  assert.equal(w.state.shells.get("sh_1").killed, null);
  assert.deepEqual([...w.state.unsettled], [FIRST_CLAIM]);
  await w.run(a, MIN);
  assert.equal(w.claims.get(FIRST_CLAIM).stop, true, "still there");

  w.cancelFails = false;
  await w.run(a, TICK);
  await settle();
  assert.equal(w.claims.get(FIRST_CLAIM).stop, false);
  assert.equal(w.state.unsettled.size, 0);
  assert.equal(a.sent.filter((message) => /still running/.test(message.text)).length, 0, "a stop that was taken back is not followed up");
});

test("kill: a command that ends while its stop is being written", async () => {
  const { w, a, release } = await atKillLimit();
  w.exit("sh_1", 100);
  await release();
  assert.equal(a.sent.length, 0, "no notice about a command that is over");
  assert.equal(w.state.notices.size, 0);
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.dropped, [FIRST_CLAIM]);
});

test("kill: a pass that lost its lease still finishes what it decided, and the next pass does not decide again", async () => {
  const { w, a, release } = await atKillLimit();
  const stale = w.state.lock;
  w.advance(10 * MIN); // stuck long enough for the lease to be taken over
  const next = tick(w.state, w.io, a);
  await settle();
  assert.notEqual(w.state.lock, stale);
  await release();
  await next;
  assert.deepEqual(w.stops, [FIRST_CLAIM], "one request");
  assert.equal(w.state.shells.get("sh_1").killed.written, true);
  await w.run(a, TICK);
  assert.equal(a.sent.filter((message) => /is being stopped/.test(message.text)).length, 1, "one notice");
  assert.equal(w.state.lock, null);
});

test("an id is taken only from this plugin's own hook, and only once", async () => {
  const { w, a } = await started();
  // Somebody pastes a command that already carries tag lines, e.g. copied from the list of commands.
  const pasted = addTag(KILL_COMMAND, "ffffffff-1111-2222-3333-444444444444");
  w.shell("sh_1", { pid: 100, command: pasted });
  const first = w.state.shells.get("sh_1");
  assert.equal(first.tag, FIRST_TAG, "the pasted id was replaced by a fresh one");
  assert.equal(first.command, KILL_COMMAND);
  assert.deepEqual([...w.claims.keys()], [FIRST_CLAIM]);

  // The same text started again is a different command with a different id.
  w.shell("sh_2", { pid: 200, command: pasted });
  assert.notEqual(w.state.shells.get("sh_2").tag, first.tag);

  // An id that reaches the registry without having been issued (the hook did not run) is ignored.
  w.created("sh_3", { pid: 300, command: pasted });
  const forged = w.state.shells.get("sh_3");
  assert.deepEqual([forged.tag, forged.claim], [null, null]);
  assert.deepEqual([forged.settings.killSilence, forged.settings.killRuntime], [0, 0]);
  assert.deepEqual(forged.notes, ["kill limits (the id in the command was not issued for this launch)"]);

  // An issued id is good for one command only.
  w.created("sh_4", { pid: 400, command: addTag(KILL_COMMAND, first.tag) });
  assert.equal(w.state.shells.get("sh_4").tag, null);

  await w.run(a, 10 * MIN);
  assert.deepEqual(w.stops.sort(), [first.claim, w.state.shells.get("sh_2").claim].sort(), "only the two guards of the two real launches");
});

test("commands without a kill limit are started exactly as they were given", async () => {
  const { w, a } = await started();
  for (const command of ["./job.sh", "# watchdog: report=5m\n./job.sh", "# watchdog: off kill-runtime=1h\n./job.sh"]) {
    const event = { command, shell: "/bin/zsh", env: {} };
    beforeCreate(w.state, w.io, a, event, w.newTag);
    assert.deepEqual(event, { command, shell: "/bin/zsh", env: {} });
  }
  assert.equal(w.state.issued.size, 0);

  // Tag lines that come with a command are removed even when it gets none of its own.
  const unlimited = "# watchdog: kill-silence=off silence=off\n./job.sh";
  const event = { command: addTag(unlimited, FIRST_TAG), shell: "/bin/zsh", env: {} };
  beforeCreate(w.state, w.io, a, event, w.newTag);
  assert.equal(event.command, unlimited);
  assert.equal(w.state.issued.size, 0);
});

test("kill limits exist only for commands with a guard; the tool cannot add one later", async () => {
  const { w, a } = await started({ killRuntime: "1m" });
  // PowerShell reads the directive but cannot run the guard line.
  w.shell("sh_1", { pid: 100, command: "# watchdog: kill-silence=1m\n./job.ps1", shell: "/usr/local/bin/pwsh" });
  const rec = w.state.shells.get("sh_1");
  assert.equal(rec.tag, null);
  assert.deepEqual([rec.settings.killSilence, rec.settings.killRuntime], [0, 0]);
  assert.deepEqual(rec.notes, ["kill limits (automatic kill needs macOS or Linux and one of sh, bash, zsh, dash, ash)"]);

  const answer = await toolCall(w.state, w.io, a, { id: "sh_1", killRuntime: "5m", report: "1m" }, "ses_1");
  assert.match(answer, /^Nothing was changed: a kill limit cannot be added to a command that was launched without one/);
  assert.equal(rec.settings.report, 0, "the valid part of a rejected call is not applied either");
  assert.equal(rec.rev, 0);
  await w.run(a, 4 * MIN);
  assert.deepEqual(w.stops, []);

  // Without a usable claims directory nothing gets a guard, and the reason is said.
  const bare = world();
  const inst = bare.instance("/a", { killRuntime: "1m" });
  inst.claims = null;
  bare.shell("sh_1", { pid: 100 });
  assert.deepEqual(bare.state.shells.get("sh_1").notes, ["kill limits (the state directory of the watchdog cannot be used)"]);
});

test("the claim of a guard is removed a while after its command is not watched any more", async () => {
  const { w, a } = await started();
  w.session("ses_2");
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND }); // ends
  w.shell("sh_2", { pid: 200, command: KILL_COMMAND }); // the agent stops watching it
  w.shell("sh_3", { pid: 300, command: KILL_COMMAND, sessionID: "ses_2" }); // its session is deleted
  w.shell("sh_4", { pid: 400, command: KILL_COMMAND, guard: false }); // its guard never starts
  w.shell("sh_5", { pid: 500, command: "# watchdog: kill-silence=1h silence=off\n./job.sh" }); // stays
  const claims = ["sh_1", "sh_2", "sh_3", "sh_4", "sh_5"].map((id) => w.state.shells.get(id).claim);

  w.exit("sh_1", 100);
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_2", off: true }, "ses_1"), /Stopped watching sh_2/);
  handleEvent(w.state, w.io, { type: "session.deleted", data: { sessionID: "ses_2" } });
  await w.run(a, TICK);
  assert.deepEqual(w.dropped, [], "kept for a minute");
  await w.run(a, 1.5 * MIN);
  assert.deepEqual(w.dropped.sort(), claims.slice(0, 4).sort());
  assert.deepEqual([...w.claims.keys()], [claims[4]]);
  assert.equal(w.state.obsolete.size + w.state.ops.size, 0);

  // Ids that were issued but never became a command do not pile up.
  for (let i = 0; i < 1200; i++) beforeCreate(w.state, w.io, a, { command: KILL_COMMAND, shell: "/bin/zsh", env: {} }, w.newTag);
  assert.equal(w.state.issued.size, 1000);
  await w.run(a, 11 * MIN);
  assert.equal(w.state.issued.size, 0);
});

test("tool: stopping to watch a command that was already told to stop", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, 2 * MIN);
  assert.deepEqual(w.stops, [FIRST_CLAIM]);
  assert.match(await toolCall(w.state, w.io, a, { id: "sh_1", off: true }, "ses_1"), /Stopped watching sh_1.* The stop it was already told to make goes ahead\./);
  await w.run(a, TICK);
  assert.equal(w.claims.get(FIRST_CLAIM).stop, true, "the stop is left for its guard");
});

// --- Events late, lost, repeated ---------------------------------------------------------------------

test("a pid that shows up in a new command ends what was watched under it", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100, command: KILL_COMMAND });
  await w.run(a, TICK);
  // sh_1 ends without an exit event, and its pid goes to a command that is not even watched.
  w.shell("sh_2", { pid: 100, command: "# watchdog: off\n./other.sh" });
  assert.equal(w.state.shells.size, 0, "sh_2 is not watched, and sh_1 is forgotten");
  await w.run(a, 5 * MIN);
  assert.deepEqual(w.stops, []);
  assert.equal(a.sent.length, 0, "no report about a command that is over");

  // The same for a command without a session, and for one waiting for its location's instance.
  w.shell("sh_3", { pid: 300 });
  w.shell("sh_4", { pid: 300, sessionID: null, command: "./anything.sh" });
  assert.equal(w.state.shells.has("sh_3"), false);
  w.shell("sh_5", { pid: 500, dir: "/elsewhere" });
  assert.equal(w.state.pending.size, 1);
  w.shell("sh_6", { pid: 500 });
  assert.equal(w.state.pending.size, 0);
  assert.deepEqual([...w.state.shells.keys()], ["sh_6"]);
});

test("an event about an earlier start of a pid does not touch the command that has the pid now", async () => {
  const { w } = await started();
  const firstStart = w.wall;
  w.created("sh_a", { pid: 100, sessionID: null, command: "./a.sh" });
  assert.equal(w.state.done.has("sh_a"), true, "an unwatched id is remembered too");
  w.wall += MIN;
  w.shell("sh_b", { pid: 100 });

  // A's event comes again: as a duplicate, and as if it had never been seen.
  w.created("sh_a", { pid: 100, sessionID: null, command: "./a.sh", started: firstStart });
  w.state.done.delete("sh_a");
  w.created("sh_a", { pid: 100, sessionID: null, command: "./a.sh", started: firstStart });
  w.created("sh_c", { pid: 100, command: "./c.sh", started: firstStart - MIN });
  assert.deepEqual([...w.state.shells.keys()], ["sh_b"], "B is still watched, and nothing older is registered beside it");
  assert.equal(w.state.done.has("sh_c"), true);
});

test("an event that arrives late is not watched, but still ends the old command of its pid", async () => {
  const { w, a } = await started();
  w.shell("sh_1", { pid: 100 });
  await w.run(a, MIN);
  const startedAt = w.wall;
  w.wall += 6 * MIN;
  w.created("sh_2", { pid: 100, command: "./late.sh", started: startedAt });
  assert.equal(w.state.shells.size, 0);
  assert.equal(w.state.done.has("sh_2"), true);

  // A replay about a start long ago neither revives a command nor takes a pid from a live one.
  w.shell("sh_new", { pid: 300 });
  w.wall += 20 * MIN;
  w.created("sh_old", { pid: 300, command: "./old.sh", started: w.wall - 90 * MIN });
  assert.deepEqual([...w.state.shells.keys()], ["sh_new"]);
  assert.equal(w.state.pending.size, 0);
});

test("a late event of a launch whose pid has gone to another command: the stop reaches only the old guard's claim", async () => {
  // A was launched with a limit; its event is held up. A ends, its pid goes to B, which is not
  // watched, so nothing tells the watchdog. Then A's event arrives.
  const { w, a } = await started();
  const first = { command: KILL_COMMAND, shell: "/bin/zsh", env: {} };
  beforeCreate(w.state, w.io, a, first, w.newTag);
  w.claims.set(FIRST_CLAIM, { pid: "100", stop: false }); // A's guard made the claim when A started
  const firstStart = w.wall;
  w.advance(20_000);
  w.alive.add(100); // the pid is B's now
  w.files.set("/out/sh_a", { ino: 100, data: Buffer.alloc(0) });
  w.created("sh_a", { pid: 100, command: first.command, started: firstStart });
  await w.run(a, 3 * MIN);
  // The limit of A "fires", and the request goes into the claim that only A's guard could make: the
  // path was in the environment of A's launch and nowhere else. That guard was a process of A's own
  // group and left when A ended. B, whatever its command line says, has no part in it.
  assert.deepEqual(w.stops, [FIRST_CLAIM]);
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
  w.advance(TICK);
  const first = tick(w.state, w.io, a);
  await settle();
  const lease = w.state.lock;
  assert.ok(lease);

  w.advance(5 * MIN);
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
  w.advance(TICK);
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
  w.advance(TICK);
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
    w.advance(TICK);
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
  assert.match(list, /^sh_1: active, no output yet \(running 1m, pid 100\)/);
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
  w.advance(TICK);
  const running = tick(w.state, w.io, a);
  await settle();
  await toolCall(w.state, w.io, a, { id: "sh_1", silence: "off" }, "ses_1");
  w.getGate.resolve();
  w.getGate = null;
  await running;
  assert.equal(a.sent.length, 0);
});
