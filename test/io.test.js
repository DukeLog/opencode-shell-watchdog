// The real adapters against real processes: what `ps` prints differs between systems, and the kill
// safety rests on it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addTag, birthTime, captureBirth, membersOf, verifyLeader, verifySurvivors } from "../src/core.js";
import { createIO } from "../src/io.js";

const posix = process.platform !== "win32";
// Every shell a command can be tagged in, as far as it is installed here.
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/dash", "/bin/ash", "/usr/bin/fish", "/opt/homebrew/bin/fish"].filter((path) => existsSync(path));

/** Starts a command the way OpenCode does: `<shell> -c <command>`, as the leader of its own group. */
function start(shell, command) {
  const startedWall = Date.now();
  const child = spawn(shell, ["-c", command], { detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { pid: child.pid, startedWall, exited };
}

/** Runs a command to its end: { code, signal, stdout }. */
function run(shell, command) {
  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", command], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code, signal) => resolve({ code, signal, stdout }));
  });
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a tagged command is bound to its process in every shell, although its last command is external", { skip: !posix }, async (t) => {
  const io = createIO();
  assert.ok(SHELLS.length > 0);
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      const tag = randomUUID();
      // Without the tag's trap line most shells would replace themselves with `sleep` and lose the tag.
      const job = start(shell, addTag("sleep 30", tag));
      const rec = { pid: job.pid, tag, startedWall: job.startedWall };
      try {
        let seen = null;
        assert.ok(await until(async () => (seen = await io.inspect(job.pid))?.argv.includes(tag)), `ps said: ${JSON.stringify(seen)}`);
        assert.equal(seen.pgid, job.pid, "the shell leads its own group");
        const found = captureBirth(seen, rec);
        assert.equal(found.error, undefined);
        assert.ok(Math.abs(job.startedWall - birthTime(found.birth)) < 2000, "ps and the spawn agree on the start");

        // The same process read again is the same process; anything else is not.
        const target = { ...rec, birth: found.birth };
        assert.equal(verifyLeader(await io.inspect(job.pid), target), null);
        assert.match(verifyLeader(await io.inspect(job.pid), { ...target, tag: randomUUID() }), /is not the command/);
        assert.match(verifyLeader(await io.inspect(process.pid), { ...target, pid: process.pid }), /another process|is not the command/);
        assert.match(captureBirth(seen, { ...rec, startedWall: job.startedWall - 60_000 }).error, /did not start when/);
        assert.match(captureBirth(await io.inspect(process.pid), { ...rec, pid: process.pid }).error, /is not the command/);

        const group = membersOf(await io.processes(), job.pid);
        assert.ok(group.some((member) => member.pid === job.pid && member.birth === found.birth), "the table and the single reading agree");
        assert.equal(io.alive(job.pid), true);
        assert.equal(io.groupAlive(job.pid), true);
      } finally {
        io.signalGroup(job.pid, "SIGTERM");
      }
      // The trap line must not turn a death by signal into something that looks like an exit.
      const end = await job.exited;
      assert.ok(end.signal === "SIGTERM" || end.code === 143, JSON.stringify(end));
      assert.ok(await until(() => !io.groupAlive(job.pid)), "the whole group is gone");
      assert.equal(io.alive(job.pid), false);
      assert.equal(await io.inspect(job.pid), null, "no such process is an answer, not an error");
    });
  }
});

test("a tagged command behaves like the same command without the tag", { skip: !posix }, async (t) => {
  const posixScripts = [
    "true",
    "(exit 7)",
    "exit 3",
    "echo out; false",
    "# watchdog: kill-runtime=1h\necho directive; exit 4",
    "f() { return 5; }; f",
    // The lines that an "exit" appended to the command would have broken:
    "exit() { return 0; }; false", // a function of that name
    "cat <<EOF\nhello", // a heredoc that runs to the end of the script
    "echo one \\", // a line continuation at the end
    // A command with an EXIT trap of its own replaces the one of the tag.
    "trap 'echo bye' EXIT\necho hi\n(exit 6)",
    "trap - EXIT\necho untrapped",
    "echo \"$#:$0\" | wc -c",
  ];
  const fishScripts = ["true", "false", "exit 3", "echo out; false", "# watchdog: kill-runtime=1h\necho directive; exit 4"];
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      for (const script of shell.endsWith("fish") ? fishScripts : posixScripts) {
        const [plain, tagged] = await Promise.all([run(shell, script), run(shell, addTag(script, randomUUID()))]);
        assert.deepEqual(tagged, plain, script);
      }
    });
  }
});

test("a child that outlives the shell is found as one of the group from before the signal", { skip: !posix }, async () => {
  const io = createIO();
  const tag = randomUUID();
  // The shell dies of SIGTERM, the subshell ignores it and stays in the group.
  const job = start("/bin/sh", addTag("(trap '' TERM; sleep 30) &\nsleep 30", tag));
  try {
    let seen = null;
    assert.ok(await until(async () => (seen = await io.inspect(job.pid))?.argv.includes(tag)));
    assert.ok(await until(async () => membersOf(await io.processes(), job.pid).length >= 3));
    const { birth } = captureBirth(seen, { pid: job.pid, tag, startedWall: job.startedWall });
    const entry = { pid: job.pid, tag, birth, members: membersOf(await io.processes(), job.pid) };
    io.signalGroup(job.pid, "SIGTERM");
    await job.exited;
    assert.equal(io.groupAlive(job.pid), true, "the leader is gone, the group is not");
    assert.equal(await io.inspect(job.pid), null);
    assert.equal(verifySurvivors(await io.processes(), await io.inspect(job.pid), entry), null);

    // With a list of other processes "from before", nobody in the group counts.
    const others = { ...entry, members: [{ pid: process.pid, birth }] };
    assert.match(verifySurvivors(await io.processes(), null, others), /is left from before the SIGTERM/);
  } finally {
    if (io.groupAlive(job.pid)) io.signalGroup(job.pid, "SIGKILL");
  }
  assert.ok(await until(() => !io.groupAlive(job.pid)));
});

test("the process table and the single reading agree about this process", { skip: !posix }, async () => {
  const io = createIO();
  const processes = await io.processes();
  const self = processes.find((proc) => proc.pid === process.pid);
  assert.ok(self, "own pid is listed");
  assert.ok(Number.isInteger(self.pgid) && self.pgid > 0);
  const seen = await io.inspect(process.pid);
  assert.deepEqual({ pgid: seen.pgid, birth: seen.birth }, { pgid: self.pgid, birth: self.birth });
  assert.match(seen.argv, /node/);
  const startedWall = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(startedWall - birthTime(self.birth)) < 3000, `born "${self.birth}"`);
  const pids = new Set(processes.map((proc) => proc.pid));
  let free = 30_000;
  while (pids.has(free)) free -= 1;
  assert.equal(await io.inspect(free), null, "a pid nobody has");
});

test("a ps that hangs, fails or prints something else is an error, never an empty answer", { skip: !posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "watchdog-ps-"));
  const fake = async (name, script) => {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
    return path;
  };
  try {
    const hanging = createIO({ ps: await fake("slow-ps", "sleep 30"), psTimeout: 200 });
    const before = Date.now();
    await assert.rejects(hanging.processes());
    await assert.rejects(hanging.inspect(process.pid));
    assert.ok(Date.now() - before < 5000, "the timeout cut it short");

    await assert.rejects(createIO({ ps: await fake("broken-ps", "echo 'ps: something is wrong' >&2; exit 2") }).inspect(process.pid));
    // Exit code 1 means "no such process" only when ps had nothing else to say.
    await assert.rejects(createIO({ ps: await fake("complaining-ps", "echo 'ps: cannot read the process table' >&2; exit 1") }).inspect(process.pid));
    await assert.rejects(createIO({ ps: await fake("partial-ps", "echo 'half an answer'; exit 1") }).inspect(process.pid));
    assert.equal(await createIO({ ps: await fake("silent-ps", "exit 1") }).inspect(process.pid), null);
    // Success with output that is not a process line is not an answer either.
    await assert.rejects(createIO({ ps: await fake("odd-ps", "echo '12 sleep 30'") }).inspect(process.pid), /unexpected/);
    await assert.rejects(createIO({ ps: await fake("empty-ps", "exit 0") }).inspect(process.pid), /unexpected/);
    assert.deepEqual(await createIO({ ps: await fake("odd-table-ps", "echo 'PID PGID STARTED'") }).processes(), []);

    await assert.rejects(createIO({ ps: join(dir, "missing-ps") }).inspect(process.pid));
    await assert.rejects(createIO({ ps: join(dir, "missing-ps") }).processes());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("output files: size, identity and a slice of bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "watchdog-out-"));
  try {
    const io = createIO({ log: join(dir, "logs", "watchdog.log") });
    const file = join(dir, "out");
    await writeFile(file, "0123456789");
    const info = await io.stat(file);
    assert.equal(info.size, 10);
    assert.ok(info.ino > 0);
    assert.equal((await io.read(file, 3, 4)).toString(), "3456");
    assert.equal((await io.read(file, 8, 100)).toString(), "89", "a short read is not an error");
    await assert.rejects(io.stat(join(dir, "missing")), { code: "ENOENT" });
    await assert.rejects(io.read(join(dir, "missing"), 0, 1), { code: "ENOENT" });

    io.log({ kind: "test" });
    assert.ok(await until(() => existsSync(join(dir, "logs", "watchdog.log"))), "the log directory is created on demand");
    createIO().log({ kind: "nowhere" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
