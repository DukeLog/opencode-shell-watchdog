// The real thing against real shells and processes: the guard that a kill-limited command runs, and
// the files through which the watchdog talks to it. The tests look at processes with `ps`; the
// plugin itself never does.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { addTag } from "../src/core.js";
import { createIO, defaultClaims } from "../src/io.js";

const posix = process.platform !== "win32";
// Every shell a command can get a guard in, as far as it is installed here.
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/dash", "/bin/ash"].filter((path) => existsSync(path));
const FAST = { poll: 1, grace: 1 };

let dir;
let claims;
let io;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "watchdog-io-"));
  claims = join(dir, "state with a space", "it's claims");
  io = createIO({ claims, log: join(dir, "logs", "watchdog.log") });
  assert.equal(await io.prepareClaims(), claims);
});
after(() => rm(dir, { recursive: true, force: true }));

/** Starts a command the way OpenCode does: `<shell> -c <command>`, as the leader of its own group. */
function start(shell, command) {
  const child = spawn(shell, ["-c", command], { detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { pid: child.pid, exited };
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

/** Pids of the processes in a process group. */
function group(pgid) {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,pgid="], { env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      const pids = [];
      for (const line of String(stdout).split("\n")) {
        const [pid, group] = line.trim().split(/\s+/).map(Number);
        if (group === pgid) pids.push(pid);
      }
      resolve(pids);
    });
  });
}

async function until(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a command with a guard behaves like the same command without it", { skip: !posix }, async (t) => {
  const scripts = [
    "true",
    "(exit 7)",
    "exit 3",
    "echo out; false",
    "# watchdog: kill-runtime=1h\necho directive; exit 4",
    "f() { return 5; }; f",
    "exit() { return 0; }; false",
    "cat <<EOF\nhello", // a heredoc that runs to the end of the script
    "echo one \\", // a line continuation at the end
    "trap 'echo bye' EXIT\necho hi\n(exit 6)",
    "echo \"$#:$0\" | wc -c",
    // The guard is not a job of the command: nothing to wait for, nothing listed, no last background pid.
    "sleep 0.2 & wait; echo waited",
    "wait; jobs; echo \"[${!:-none}]\"",
    "set -eu; echo strict; false; echo unreachable",
    "exec sh -c 'echo replaced; exit 9'",
  ];
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      for (const script of scripts) {
        const started = Date.now();
        const [plain, tagged] = await Promise.all([run(shell, script), run(shell, addTag(script, randomUUID(), claims, FAST))]);
        assert.deepEqual(tagged, plain, script);
        assert.ok(Date.now() - started < 4000, `the guard does not hold the command up: ${script}`);
      }
    });
  }
});

test("the guard claims its id for its shell, stops its own process group when told, and nothing else", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      const tag = randomUUID();
      // A child that ignores SIGTERM, and a last command the shell replaces itself with.
      const job = start(shell, addTag("(trap '' TERM; sleep 60) &\nsleep 60", tag, claims, FAST));
      const bystander = start(shell, "sleep 60");
      try {
        assert.ok(await until(async () => (await io.readClaim(tag)) === String(job.pid)), `claim: ${await io.readClaim(tag)}`);
        assert.ok((await group(job.pid)).length >= 3, "the command, its child and the guard share one group");
        assert.equal(io.alive(job.pid), true);

        await io.requestStop(tag);
        const end = await job.exited;
        assert.ok(end.signal === "SIGTERM" || end.code === 143, `the command got SIGTERM: ${JSON.stringify(end)}`);
        assert.ok(await until(async () => (await group(job.pid)).length === 0), "SIGKILL took the child that ignored SIGTERM, and the guard itself");
        assert.equal(io.alive(job.pid), false);
        assert.equal(io.alive(bystander.pid), true, "another command is not touched");
      } finally {
        for (const pid of [job.pid, bystander.pid]) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    });
  }
});

test("a shell that does not lead a process group of its own gets no guard", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      const tag = randomUUID();
      // Not detached: the shell stays in the group of this test process, which a guard must never stop.
      const child = spawn(shell, ["-c", addTag("sleep 3", tag, claims, FAST)], { stdio: "ignore" });
      const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(await io.readClaim(tag), null, "nothing was claimed");
      await assert.rejects(io.requestStop(tag), { code: "ENOENT" }, "so nothing can be told to stop");
      assert.deepEqual(await exited, { code: 0, signal: null }, "the command runs to its end");
    });
  }
});

test("an id can be claimed once: the same text run again has no guard that could be told anything", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      const tag = randomUUID();
      const text = addTag("sleep 60", tag, claims, FAST);
      const first = start(shell, text);
      assert.ok(await until(async () => (await io.readClaim(tag)) === String(first.pid)));
      // The very same text again, id and all: as a command of its own, and inside another command.
      const copy = start(shell, text);
      const nested = start(shell, `sleep 60 &\n${shell} -c '${text.replace(/'/g, `'\\''`)}'`);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(await io.readClaim(tag), String(first.pid), "the claim stays with the first");

        await io.requestStop(tag);
        await first.exited;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(io.alive(copy.pid), true, "the copy is not stopped");
        assert.equal(io.alive(nested.pid), true, "nor is the command that ran the text in a nested shell");
      } finally {
        for (const pid of [first.pid, copy.pid, nested.pid]) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    });
  }
});

test("the guard leaves with its command, and when its claim is removed", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      // The command ends: the guard notices that its shell is gone.
      const short = randomUUID();
      const job = start(shell, addTag("sleep 1", short, claims, FAST));
      assert.deepEqual(await job.exited, { code: 0, signal: null });
      assert.ok(await until(async () => (await group(job.pid)).length === 0), "nothing of the group is left");
      assert.equal(await io.readClaim(short), String(job.pid), "the claim stays until the watchdog removes it");

      // The command goes on, but is not watched any more: without its claim the guard leaves.
      const tag = randomUUID();
      const long = start(shell, addTag("sleep 60", tag, claims, FAST));
      try {
        assert.ok(await until(async () => (await io.readClaim(tag)) === String(long.pid)));
        const size = (await group(long.pid)).length;
        await io.dropClaim(tag);
        assert.ok(await until(async () => (await group(long.pid)).length < size), "the guard is gone");
        assert.equal(io.alive(long.pid), true, "the command is not");
        // A stop for a claim that does not exist cannot even be written.
        await assert.rejects(io.requestStop(tag), { code: "ENOENT" });
      } finally {
        try {
          process.kill(-long.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    });
  }
});

test("claims: read, stop, take back, drop, sweep", async () => {
  assert.equal(defaultClaims({ XDG_STATE_HOME: "/x/state" }), join("/x/state", "opencode-shell-watchdog", "claims"));
  assert.match(defaultClaims({}), /\.local[\\/]state[\\/]opencode-shell-watchdog[\\/]claims$/);
  assert.equal(await createIO({ claims: "/tmp/with\na line break" }).prepareClaims(), null);
  await writeFile(join(dir, "a-file"), "");
  assert.equal(await createIO({ claims: join(dir, "a-file", "below a file") }).prepareClaims(), null);

  const tag = randomUUID();
  assert.equal(await io.readClaim(tag), null, "nobody has claimed it");
  await assert.rejects(io.requestStop(tag), { code: "ENOENT" });
  await run("/bin/sh", `mkdir '${claims.replace(/'/g, `'\\''`)}/${tag}' && echo 4242 > '${claims.replace(/'/g, `'\\''`)}/${tag}/pid'`);
  assert.equal(await io.readClaim(tag), "4242");
  await io.requestStop(tag);
  await io.requestStop(tag); // asking twice is asking once
  assert.equal(existsSync(join(claims, tag, "stop")), true);
  await io.cancelStop(tag);
  await io.cancelStop(tag);
  assert.equal(existsSync(join(claims, tag, "stop")), false);

  // Old claims of commands nobody watches go; fresh ones and those still in use stay.
  const [old, kept, fresh] = [randomUUID(), randomUUID(), randomUUID()];
  for (const name of [old, kept, fresh]) await run("/bin/sh", `mkdir '${claims.replace(/'/g, `'\\''`)}/${name}'`);
  const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000);
  await utimes(join(claims, old), longAgo, longAgo);
  await utimes(join(claims, kept), longAgo, longAgo);
  await io.sweepClaims(new Set([kept]), 24 * 60 * 60_000);
  const left = await readdir(claims);
  assert.deepEqual([left.includes(old), left.includes(kept), left.includes(fresh), left.includes(tag)], [false, true, true, true]);

  await io.dropClaim(tag);
  await io.dropClaim(tag);
  assert.equal(await io.readClaim(tag), null);
  await createIO({ claims: join(dir, "no such directory") }).sweepClaims(new Set(), 0);
});

test("output files: size, identity and a slice of bytes", async () => {
  const file = join(dir, "out");
  await writeFile(file, "0123456789");
  const info = await io.stat(file);
  assert.equal(info.size, 10);
  assert.ok(info.ino > 0);
  assert.equal((await io.read(file, 3, 4)).toString(), "3456");
  assert.equal((await io.read(file, 8, 100)).toString(), "89", "a short read is not an error");
  await assert.rejects(io.stat(join(dir, "missing")), { code: "ENOENT" });
  await assert.rejects(io.read(join(dir, "missing"), 0, 1), { code: "ENOENT" });

  assert.equal(io.alive(process.pid), true);
  io.log({ kind: "test" });
  assert.ok(await until(() => existsSync(join(dir, "logs", "watchdog.log"))), "the log directory is created on demand");
  assert.match(await readFile(join(dir, "logs", "watchdog.log"), "utf8"), /"kind":"test"/);
  createIO({ claims }).log({ kind: "nowhere" });
});
