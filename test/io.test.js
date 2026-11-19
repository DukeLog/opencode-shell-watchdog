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
import { addTag, verifyLeader, verifySurvivors } from "../src/core.js";
import { createIO } from "../src/io.js";

const posix = process.platform !== "win32";
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh", "/usr/bin/fish", "/opt/homebrew/bin/fish"].filter((path) => existsSync(path));

/** Starts a command the way OpenCode does: `<shell> -c <command>`, as the leader of its own group. */
function start(shell, command) {
  const child = spawn(shell, ["-c", command], { detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { pid: child.pid, exited };
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a tagged command is recognised by its pid in every shell, although its last command is external", { skip: !posix }, async (t) => {
  const io = createIO();
  assert.ok(SHELLS.length > 0);
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      const tag = randomUUID();
      // Without the tag's last line the shell would replace itself with `sleep` and lose the tag.
      const job = start(shell, addTag("sleep 30", tag));
      try {
        let argv = "";
        assert.ok(await until(async () => (argv = await io.argv(job.pid)).includes(tag)), `argv was: ${argv}`);
        const processes = await io.processes();
        assert.equal(verifyLeader(processes, argv, { pid: job.pid, tag }), null);
        assert.match(verifyLeader(processes, argv, { pid: job.pid, tag: randomUUID() }), /is not the command/);
        assert.match(verifyLeader(processes, await io.argv(process.pid), { pid: process.pid, tag }), /is not the command/);
        assert.equal(io.alive(job.pid), true);
        assert.equal(io.groupAlive(job.pid), true);
      } finally {
        io.signalGroup(job.pid, "SIGTERM");
      }
      const end = await job.exited;
      assert.ok(end.signal === "SIGTERM" || end.code === 143, JSON.stringify(end));
      assert.ok(await until(() => !io.groupAlive(job.pid)), "the whole group is gone");
      assert.equal(io.alive(job.pid), false);
      assert.equal(await io.argv(job.pid), "", "no such process is an answer, not an error");
    });
  }
});

test("the tag's last line keeps the exit status of the command", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      const failing = shell.endsWith("fish") ? "false" : "(exit 7)";
      const expected = shell.endsWith("fish") ? 1 : 7;
      assert.equal((await start(shell, addTag(failing, randomUUID())).exited).code, expected);
      assert.equal((await start(shell, addTag("true", randomUUID())).exited).code, 0);
      assert.equal((await start(shell, addTag("# watchdog: kill-runtime=1h\nexit 3", randomUUID())).exited).code, 3);
    });
  }
});

test("a child that outlives the shell is found as a survivor of its group", { skip: !posix }, async () => {
  const io = createIO();
  const tag = randomUUID();
  // The shell dies of SIGTERM, the subshell ignores it and stays in the group.
  const job = start("/bin/sh", addTag("(trap '' TERM; sleep 30) &\nsleep 30", tag));
  try {
    assert.ok(await until(async () => (await io.argv(job.pid)).includes(tag)));
    assert.ok(await until(async () => (await io.processes()).filter((proc) => proc.pgid === job.pid).length >= 3));
    // ps knows start times to the second: let the group get clearly older than the signal.
    await new Promise((resolve) => setTimeout(resolve, 3200));
    const termWall = io.wall();
    io.signalGroup(job.pid, "SIGTERM");
    await job.exited;
    assert.equal(io.groupAlive(job.pid), true, "the leader is gone, the group is not");
    assert.equal(await io.argv(job.pid), "");
    const entry = { pid: job.pid, tag, termWall };
    assert.equal(verifySurvivors(await io.processes(), await io.argv(job.pid), entry), null);
    // Had the signal gone out before these processes existed, they would be somebody else's.
    assert.match(verifySurvivors(await io.processes(), "", { ...entry, termWall: termWall - 4000 }), /predates/);
  } finally {
    if (io.groupAlive(job.pid)) io.signalGroup(job.pid, "SIGKILL");
  }
  assert.ok(await until(() => !io.groupAlive(job.pid)));
});

test("the process table has this process in it, with a plausible start time", { skip: !posix }, async () => {
  const io = createIO();
  const processes = await io.processes();
  const self = processes.find((proc) => proc.pid === process.pid);
  assert.ok(self, "own pid is listed");
  assert.ok(Number.isInteger(self.pgid) && self.pgid > 0);
  const uptime = process.uptime() * 1000;
  assert.ok(Math.abs(io.wall() - uptime - self.startedWall) < 5000, "started when this process started");
  assert.match(await io.argv(process.pid), /node/);
});

test("a ps that hangs or fails is an error, never an empty answer", { skip: !posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "watchdog-ps-"));
  try {
    const slow = join(dir, "slow-ps");
    await writeFile(slow, "#!/bin/sh\nsleep 30\n");
    await chmod(slow, 0o755);
    const hanging = createIO({ ps: slow, psTimeout: 200 });
    const before = Date.now();
    await assert.rejects(hanging.processes());
    await assert.rejects(hanging.argv(process.pid));
    assert.ok(Date.now() - before < 5000, "the timeout cut it short");

    const broken = join(dir, "broken-ps");
    await writeFile(broken, "#!/bin/sh\necho 'ps: something is wrong' >&2\nexit 2\n");
    await chmod(broken, 0o755);
    await assert.rejects(createIO({ ps: broken }).argv(process.pid));
    await assert.rejects(createIO({ ps: join(dir, "missing-ps") }).argv(process.pid));
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
