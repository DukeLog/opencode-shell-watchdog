// The real thing against real shells and processes: the guard that a kill-limited command runs, and
// the files through which the watchdog talks to it. The tests look at processes with `ps`; the
// plugin itself never does.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CLAIM_ENV, addTag } from "../src/core.js";
import { createIO, defaultClaims } from "../src/io.js";

const posix = process.platform !== "win32";
// Every shell a command can get a guard in, as far as it is installed here.
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/dash", "/bin/ash"].filter((path) => existsSync(path));
const FAST = { poll: 1, grace: 1 };

let dir;
let space;
let io;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "watchdog-io-"));
  io = createIO({ claims: join(dir, "state with a space", "it's claims"), log: join(dir, "logs", "watchdog.log") });
  space = await io.prepareClaims("server-1");
  assert.equal(space, join(dir, "state with a space", "it's claims", "server-1"));
});
after(() => rm(dir, { recursive: true, force: true }));

/** A command with a guard, as the hook launches it: the text, and the environment with the claim. */
function guarded(script, extraEnv = {}) {
  const tag = randomUUID();
  const claim = join(space, tag);
  return { tag, claim, command: addTag(script, tag, FAST), env: { ...process.env, ...extraEnv, [CLAIM_ENV]: claim } };
}

/** Starts a command the way OpenCode does: `<shell> -c <command>`, as the leader of its own group. */
function start(shell, command, env = process.env, detached = true) {
  const child = spawn(shell, ["-c", command], { detached, stdio: "ignore", env });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { pid: child.pid, exited };
}

/** Runs a command to its end, as the leader of its own group: { code, signal, stdout }. */
function run(shell, command, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", command], { detached: true, stdio: ["ignore", "pipe", "ignore"], env });
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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The processes of some groups, as text, for messages of failed checks. */
function snapshot(...pgids) {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,args="], { env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      const lines = String(stdout).split("\n").filter((line) => pgids.includes(Number(line.trim().split(/\s+/)[2])));
      resolve(`winner ${pgids[0]}, loser ${pgids[1]}\n${lines.map((line) => line.slice(0, 150)).join("\n")}`);
    });
  });
}

/** How a started command ended, or "running" if it has not. For messages of failed checks. */
const ended = (job) => Promise.race([job.exited, pause(200).then(() => "running")]);

function killGroups(...pids) {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

test("a command with a live guard behaves like the same command without one", { skip: !posix }, async (t) => {
  const scripts = [
    "true",
    "(exit 7)",
    "exit 3",
    "echo out; false",
    "# watchdog: kill-runtime=1h\necho directive; exit 4",
    // The guard goes below the comment lines a command opens with, wherever they end.
    "# nightly build\n# watchdog: kill-runtime=1h\necho named; exit 4",
    "#!/bin/sh\n# nightly build\necho shebang; (exit 2)",
    "# nightly build\ncat <<EOF\nbody $((1 + 1))\nEOF",
    "# nightly build\n\n# later\necho gap; exit 6",
    "# odd \\\necho after a comment that ends in a backslash; exit 3",
    "# nightly build\n# odd \\\necho mixed; exit 5",
    "# nothing but\n# comments",
    "# a comment and no newline",
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
    // The claim is for the guard alone: the command does not find it in its environment.
    `echo "[\${${CLAIM_ENV}:-not set}]"; env | grep -c ${CLAIM_ENV}`,
  ];
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      for (const script of scripts) {
        const job = guarded(script);
        const started = Date.now();
        const [plain, tagged] = await Promise.all([run(shell, script), run(shell, job.command, job.env)]);
        assert.deepEqual(tagged, plain, script);
        assert.ok(Date.now() - started < 4000, `the guard does not hold the command up: ${script}`);
        assert.ok(await until(() => existsSync(`${job.claim}.pid`), 3000), `a guard was really running beside: ${script}`);
      }
    });
  }
});

test("the guard makes its claim for its shell, stops its own process group when told, and nothing else", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      // A child that ignores SIGTERM, and a last command the shell replaces itself with. Once as it
      // is, once below comment lines: there the guard is not the first thing in the text.
      for (const head of ["", "# nightly build\n# watchdog: kill-runtime=1h\n"]) {
        const job = guarded(`${head}(trap '' TERM; sleep 60) &\nsleep 60`);
        assert.equal(job.command.startsWith(head), true);
        const main = start(shell, job.command, job.env);
        const bystander = start(shell, "sleep 60");
        try {
          assert.ok(await until(async () => (await io.readClaim(job.claim)) === String(main.pid)), `claim: ${await io.readClaim(job.claim)}`);
          assert.ok((await group(main.pid)).length >= 3, "the command, its child and the guard share one group");
          assert.equal(io.alive(main.pid), true);

          await io.requestStop(job.claim);
          const end = await main.exited;
          assert.ok(end.signal === "SIGTERM" || end.code === 143, `the command got SIGTERM: ${JSON.stringify(end)}`);
          assert.ok(await until(async () => (await group(main.pid)).length === 0), "SIGKILL took the child that ignored SIGTERM, and the guard itself");
          assert.equal(io.alive(main.pid), false);
          assert.equal(io.alive(bystander.pid), true, "another command is not touched");
        } finally {
          killGroups(main.pid, bystander.pid);
        }
      }
    });
  }
});

test("the text of a command can be copied anywhere: without the launch's environment it starts no guard", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      const job = guarded("sleep 60");
      const first = start(shell, job.command, job.env);
      assert.ok(await until(async () => (await io.readClaim(job.claim)) === String(first.pid)));
      // The very same text again, id and all: as a command of its own, inside another command, and
      // even with the environment of the first launch handed over on purpose.
      const copy = start(shell, job.command);
      const nested = start(shell, `sleep 60 &\n${shell} -c '${job.command.replace(/'/g, `'\\''`)}'`);
      const replay = start(shell, job.command, job.env);
      try {
        await pause(1500);
        assert.equal(await io.readClaim(job.claim), String(first.pid), "the claim stays with the first");

        await io.requestStop(job.claim);
        await first.exited;
        await pause(2500);
        assert.equal(io.alive(copy.pid), true, "the copy is not stopped");
        assert.equal(io.alive(nested.pid), true, "nor is the command that ran the text in a nested shell");
        assert.equal(io.alive(replay.pid), true, "nor one that was given the same claim: it can be made once");
      } finally {
        killGroups(first.pid, copy.pid, nested.pid, replay.pid);
      }
    });
  }
});

test("two launches with one claim, started at the same moment, many times: one guard, never two", { skip: !posix }, async () => {
  // What a claim made with `mkdir` got wrong where mkdir is not atomic (uutils): both got in.
  const shell = "/bin/sh";
  const rounds = Array.from({ length: 24 }, () => guarded("sleep 20"));
  const pairs = rounds.map((job) => [start(shell, job.command, job.env), start(shell, job.command, job.env)]);
  try {
    for (const job of rounds) assert.ok(await until(async () => (await io.readClaim(job.claim)) !== null), "somebody made the claim");
    await pause(1200);
    await Promise.all(rounds.map((job) => io.requestStop(job.claim)));
    await pause(3500);
    const alive = pairs.map((pair) => pair.filter((job) => io.alive(job.pid)).length);
    assert.deepEqual(alive, pairs.map(() => 1), "of every pair exactly one is stopped");
    for (const [index, job] of rounds.entries()) {
      const owner = Number(await io.readClaim(job.claim));
      const stopped = pairs[index].find((launch) => !io.alive(launch.pid));
      assert.equal(owner, stopped.pid, "and it is the one whose pid is in the claim");
    }
  } finally {
    killGroups(...pairs.flat().map((job) => job.pid));
  }
});

test("no guard where it could not be sure of its group: a shell that leads none, or job control", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      // Not detached: the shell stays in the group of this test process, which a guard must never stop.
      const job = guarded("sleep 3");
      const inside = start(shell, job.command, job.env, false);
      await pause(1500);
      assert.equal(await io.readClaim(job.claim), null, "nothing was claimed");
      await assert.rejects(io.requestStop(job.claim), { code: "ENOENT" }, "so nothing can be told to stop");
      assert.deepEqual(await inside.exited, { code: 0, signal: null }, "the command runs to its end");

      // Job control puts every background job into a group of its own: the guard would not be in the
      // command's group, and gives up.
      const monitored = guarded("set -m 2>/dev/null; sleep 3");
      const withJobs = start(shell, `set -m 2>/dev/null\n${monitored.command.split("\n").slice(1).join("\n")}`, monitored.env);
      await pause(1500);
      const claimed = await io.readClaim(monitored.claim);
      const groupOfGuard = claimed === null ? [] : await group(withJobs.pid);
      // Either no claim at all, or (a shell without job control) a guard that really is in the group.
      assert.ok(claimed === null || groupOfGuard.length >= 2, `claim ${claimed}, group ${groupOfGuard}`);
      await withJobs.exited;
    });
  }
});

test("the guard does not depend on the user's shell setup: aliases, functions, PATH", { skip: !posix }, async (t) => {
  // Startup files that redefine everything the guard line could be thought to use.
  const home = await mkdtemp(join(dir, "home-"));
  const traps = [
    "alias mkdir='mkdir -p'",
    "alias sh='echo not-a-shell'",
    "alias unset='true'",
    "alias kill='true'",
    "mkdir() { command mkdir -p \"$@\"; }",
    "sleep() { return 1; }",
    "kill() { return 0; }",
    "ps() { echo 1; }",
  ].join("\n");
  await writeFile(join(home, ".zshenv"), `${traps}\nalias -g TERM=KILL\n`);
  await writeFile(join(home, "bash_env"), `shopt -s expand_aliases\n${traps}\nexport -f mkdir sleep kill ps\n`);
  await mkdir(join(home, "bin"));
  for (const tool of ["mkdir", "sleep", "ps", "tr"]) {
    await writeFile(join(home, "bin", tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  const hostile = { ZDOTDIR: home, BASH_ENV: join(home, "bash_env"), ENV: join(home, "bash_env"), PATH: `${join(home, "bin")}:${process.env.PATH}` };

  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      const job = guarded("/bin/sleep 60", hostile);
      const first = start(shell, job.command, job.env);
      const replay = start(shell, job.command, job.env);
      try {
        assert.ok(await until(async () => (await io.readClaim(job.claim)) !== null), "the guard started all the same");
        await pause(1200);
        const owner = Number(await io.readClaim(job.claim));
        assert.ok(owner === first.pid || owner === replay.pid);
        const [winner, loser] = owner === first.pid ? [first, replay] : [replay, first];
        assert.equal(io.alive(loser.pid), true, `the other launch runs on without a guard: ${JSON.stringify(await ended(loser))}`);
        const before = await snapshot(winner.pid, loser.pid);
        await io.requestStop(job.claim);
        await winner.exited;
        assert.ok(await until(async () => (await group(winner.pid)).length === 0), "the group of the claim's owner is stopped");
        await pause(1500);
        assert.equal(io.alive(loser.pid), true, `the claim was made once, whatever mkdir is said to be: ${JSON.stringify(await ended(loser))}\n${before}`);
      } finally {
        killGroups(first.pid, replay.pid);
      }
    });
  }
});

test("the guard leaves with its command, and when its claim is removed", { skip: !posix }, async (t) => {
  for (const shell of SHELLS) {
    await t.test(shell, async () => {
      // The command ends: the guard notices that its shell is gone.
      const short = guarded("sleep 1");
      const quick = start(shell, short.command, short.env);
      assert.deepEqual(await quick.exited, { code: 0, signal: null });
      assert.ok(await until(async () => (await group(quick.pid)).length === 0), "nothing of the group is left");
      assert.equal(await io.readClaim(short.claim), String(quick.pid), "the claim stays until the watchdog removes it");

      // The command goes on, but is not watched any more: without its claim the guard leaves.
      const job = guarded("sleep 60");
      const long = start(shell, job.command, job.env);
      try {
        assert.ok(await until(async () => (await io.readClaim(job.claim)) === String(long.pid)));
        const size = (await group(long.pid)).length;
        await io.dropClaim(job.claim);
        assert.ok(await until(async () => (await group(long.pid)).length < size), "the guard is gone");
        assert.equal(io.alive(long.pid), true, "the command is not");
        // A stop for a claim that does not exist cannot even be written.
        await assert.rejects(io.requestStop(job.claim), { code: "ENOENT" });
      } finally {
        killGroups(long.pid);
      }
    });
  }
});

test("claims: a part of the directory for every server; read, stop, take back, drop, sweep", async () => {
  assert.equal(defaultClaims({ XDG_STATE_HOME: "/x/state" }), join("/x/state", "opencode-shell-watchdog", "claims"));
  assert.match(defaultClaims({}), /\.local[\\/]state[\\/]opencode-shell-watchdog[\\/]claims$/);
  await writeFile(join(dir, "a-file"), "");
  assert.equal(await createIO({ claims: join(dir, "a-file", "below a file") }).prepareClaims("server"), null);

  const claim = join(space, randomUUID());
  assert.equal(await io.readClaim(claim), null, "nobody has made it");
  await assert.rejects(io.requestStop(claim), { code: "ENOENT" });
  await writeFile(`${claim}.pid`, "4242\n");
  assert.equal(await io.readClaim(claim), "4242");
  await io.requestStop(claim);
  await io.requestStop(claim); // asking twice is asking once
  assert.equal(existsSync(`${claim}.stop`), true);
  await io.cancelStop(claim);
  await io.cancelStop(claim);
  assert.equal(existsSync(`${claim}.stop`), false);
  await io.requestStop(claim);
  await io.dropClaim(claim);
  await io.dropClaim(claim);
  assert.equal(await io.readClaim(claim), null);
  assert.equal(existsSync(`${claim}.stop`), false, "a claim leaves nothing behind");
  await assert.rejects(io.requestStop(claim), "a claim that nobody made cannot be told to stop");
  assert.equal(existsSync(`${claim}.stop`), false);

  // Every server has a part of its own, and none ever removes another's, however old it looks:
  // a guard of a long-running command may be at work in it.
  const base = join(space, "..");
  const other = await io.prepareClaims("server-2");
  const theirs = `${join(other, randomUUID())}.pid`;
  await writeFile(theirs, "1\n");
  const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60_000);
  await utimes(other, longAgo, longAgo);
  assert.equal(await io.prepareClaims("server-1"), space, "making the own part again changes nothing");
  assert.deepEqual((await readdir(base)).sort(), ["server-1", "server-2"]);
  assert.ok(existsSync(theirs));
  assert.equal(typeof io.sweepClaims, "undefined");
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
  createIO({ claims: join(dir, "elsewhere") }).log({ kind: "nowhere" });
});
