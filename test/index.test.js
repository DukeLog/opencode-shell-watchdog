// The plugin entry against a fake OpenCode context: what it registers, and what it leaves behind.

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import plugin from "../src/index.js";
import { CLAIM_ENV, guardLine, splitTag } from "../src/core.js";

// The plugin keeps the claims of guards under the state directory: give it one of its own here.
const STATE = mkdtempSync(join(tmpdir(), "watchdog-state-"));
process.env.XDG_STATE_HOME = STATE;
// Every server process has a part of its own in there.
const claims = () => join(STATE, "opencode-shell-watchdog", "claims", sharedState().space);
after(() => rmSync(STATE, { recursive: true, force: true }));
import { follow, sleep } from "../src/stream.js";
import { sharedState } from "../src/watchdog.js";

function fakeContext({ directory, options = {}, failHook = false, failTool = false } = {}) {
  const ctx = {
    options: { tick: "30s", ...options },
    app: { version: "test" },
    location: { directory },
    hooks: [],
    tools: [],
    disposed: [],
    streams: [],
    event: {
      subscribe({ types, signal }) {
        ctx.streams.push({ types, signal });
        return (async function* () {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        })();
      },
    },
    shell: {
      async hook(name, run) {
        if (failHook) throw new Error("hooks are not available");
        ctx.hooks.push({ name, run });
        return { dispose: async () => void ctx.disposed.push("hook") };
      },
    },
    tool: {
      async transform(edit) {
        if (failTool) throw new Error("tools are not available");
        edit({ add: (tool) => ctx.tools.push(tool) });
        return { dispose: async () => void ctx.disposed.push("tool") };
      },
    },
    session: { get: async () => null, synthetic: async () => {} },
  };
  return ctx;
}

/** The plugin's timers never keep a process alive, so a test that waits for one has to. */
async function keepingAlive(run) {
  const hold = setInterval(() => {}, 1000);
  try {
    return await run();
  } finally {
    clearInterval(hold);
  }
}

const instancesAt = (directory) => [...sharedState().instances].filter((inst) => inst.dir === directory);

test("setup registers the hook, the tool and one instance; cleanup takes all of it back", async () => {
  const ctx = fakeContext({ directory: "/index-1" });
  const cleanup = await plugin.setup(ctx);
  assert.equal(plugin.id, "shell-watchdog");
  assert.deepEqual(ctx.hooks.map((hook) => hook.name), ["create.before"]);
  assert.equal(instancesAt("/index-1").length, 1);
  assert.match(sharedState().space, /^[0-9a-f-]{36}$/);
  assert.equal(instancesAt("/index-1")[0].claims, claims());
  assert.ok(existsSync(claims()), "the claims directory is made at setup");
  assert.equal(ctx.streams.length, 1);
  assert.deepEqual(ctx.streams[0].types, ["shell.created", "shell.exited", "shell.deleted", "session.deleted"]);

  const [tool] = ctx.tools;
  assert.equal(tool.name, "watchdog");
  assert.deepEqual(tool.options, { pinned: true });
  assert.equal(tool.input.additionalProperties, false);
  // Code Mode shows the first paragraph only, cut at about 500 characters: the launch syntax has to
  // be in it, whole.
  const [firstParagraph] = tool.description.split("\n\n");
  assert.doesNotMatch(firstParagraph, /\n/);
  assert.ok(firstParagraph.length <= 480, `${firstParagraph.length} characters`);
  for (const example of ['"# watchdog: report=5m"', '"# watchdog: silence=30m"', '"# watchdog: kill-runtime=2h kill-silence=20m"', '"# watchdog: off"']) {
    assert.ok(firstParagraph.includes(example), example);
  }
  assert.match(firstParagraph, /Call with no arguments to list watched commands/);
  assert.match(firstParagraph, /a comment line under a first comment naming the job/, "where the line goes, so that lists of commands stay readable");
  assert.match(tool.description, /\n# nightly build of the docs\n# watchdog: report=10m silence=off\n\.\/build\.sh\n/, "one whole example");
  const listed = await tool.execute({}, { sessionID: "ses_index" });
  assert.match(listed.content, /No shell command of this session is being watched/);

  await cleanup();
  assert.deepEqual(ctx.disposed.sort(), ["hook", "tool"]);
  assert.equal(instancesAt("/index-1").length, 0);
  assert.equal(ctx.streams[0].signal.aborted, true);
});

test("the hook gives every launch of a kill-limited command a guard and a claim of its own", async () => {
  const ctx = fakeContext({ directory: "/index-2" });
  const cleanup = await plugin.setup(ctx);
  const launch = (command, env = { PATH: "/bin" }) => ({ command, shell: "/bin/zsh", env: { ...env } });
  try {
    const [{ run }] = ctx.hooks;
    const plain = launch("./job.sh");
    await run(plain);
    assert.deepEqual(plain, launch("./job.sh"), "no kill limit: neither the command nor its environment is touched");
    const directed = launch("# watchdog: report=5m\n./job.sh");
    await run(directed);
    assert.deepEqual(directed, launch("# watchdog: report=5m\n./job.sh"));

    const text = "# watchdog: kill-runtime=2h\n./job.sh";
    const first = launch(text);
    const second = launch(text);
    await run(first);
    await run(second);
    const tags = [splitTag(first.command), splitTag(second.command)];
    assert.match(tags[0].tag, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(tags[0].tag, tags[1].tag);
    assert.deepEqual(tags.map((split) => split.command), [text, text]);
    assert.deepEqual(first.command.split("\n"), ["# watchdog: kill-runtime=2h", `# shell-watchdog:${tags[0].tag}`, guardLine(), "./job.sh"]);

    // A command that opens with a name for itself keeps that name as its first line.
    const named = launch(`# nightly build\n${text}`);
    await run(named);
    const mark = splitTag(named.command);
    assert.deepEqual(named.command.split("\n"), ["# nightly build", "# watchdog: kill-runtime=2h", `# shell-watchdog:${mark.tag}`, guardLine(), "./job.sh"]);
    assert.equal(mark.command, `# nightly build\n${text}`);
    assert.equal(named.env[CLAIM_ENV], join(claims(), mark.tag));
    assert.deepEqual(first.env, { PATH: "/bin", [CLAIM_ENV]: join(claims(), tags[0].tag) }, "the claim travels in the environment only");
    assert.equal(second.env[CLAIM_ENV], join(claims(), tags[1].tag));

    // The already tagged text launched once more, with the old claim still in the environment (as a
    // child of the first command would have it): neither the old id nor the old claim is taken over.
    const again = launch(first.command, first.env);
    await run(again);
    const fresh = splitTag(again.command);
    assert.notEqual(fresh.tag, tags[0].tag);
    assert.equal(again.command.match(/# shell-watchdog:/g).length, 1);
    assert.equal(fresh.command, text);
    assert.equal(again.env[CLAIM_ENV], join(claims(), fresh.tag));

    // The same without a kill limit: tag lines and claim are simply removed.
    const unlimited = launch(first.command.replace("kill-runtime=2h", "report=5m"), first.env);
    await run(unlimited);
    assert.deepEqual(unlimited, launch("# watchdog: report=5m\n./job.sh"));

    for (const split of [...tags, mark, fresh]) assert.equal(sharedState().issued.get(split.tag).claim, join(claims(), split.tag));
  } finally {
    sharedState().issued.clear();
    await cleanup();
  }

  // After cleanup the hook of the old instance does nothing.
  const late = launch("# watchdog: kill-runtime=2h\n./job.sh");
  await ctx.hooks[0].run(late);
  assert.deepEqual(late, launch("# watchdog: kill-runtime=2h\n./job.sh"));
});

test("a kill limit from the plugin options gives every command a guard", async () => {
  const ctx = fakeContext({ directory: "/index-3", options: { killRuntime: "6h" } });
  const cleanup = await plugin.setup(ctx);
  try {
    const event = { command: "./job.sh", shell: "/bin/bash", env: {} };
    await ctx.hooks[0].run(event);
    assert.equal(splitTag(event.command).command, "./job.sh");
    assert.notEqual(splitTag(event.command).tag, null);
    assert.equal(event.env[CLAIM_ENV], join(claims(), splitTag(event.command).tag));
    const off = { command: "# watchdog: kill-runtime=off\n./job.sh", shell: "/bin/bash", env: {} };
    await ctx.hooks[0].run(off);
    assert.deepEqual(off, { command: "# watchdog: kill-runtime=off\n./job.sh", shell: "/bin/bash", env: {} });
  } finally {
    sharedState().issued.clear();
    await cleanup();
  }
});

test("a registration that fails leaves nothing behind", async () => {
  const noTool = fakeContext({ directory: "/index-4", failTool: true });
  await assert.rejects(plugin.setup(noTool), /tools are not available/);
  assert.deepEqual(noTool.disposed, ["hook"], "the hook that was already registered is removed");
  assert.equal(instancesAt("/index-4").length, 0);
  assert.equal(noTool.streams.length, 0, "no event stream was opened");

  const noHook = fakeContext({ directory: "/index-5", failHook: true });
  await assert.rejects(plugin.setup(noHook), /hooks are not available/);
  assert.deepEqual(noHook.disposed, []);
  assert.equal(noHook.tools.length, 0);
  assert.equal(instancesAt("/index-5").length, 0);
  assert.equal(noHook.streams.length, 0);
});

test("sleep leaves no listener on the signal, however often it is used", async () => {
  const controller = new AbortController();
  await keepingAlive(async () => {
    for (let i = 0; i < 40; i++) await sleep(1, controller.signal);
  });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  const waiting = sleep(60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await waiting;
  await sleep(60_000, controller.signal); // already aborted: returns at once
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("the event stream is reopened when it ends or fails, and dropped on abort", async () => {
  const controller = new AbortController();
  const seen = [];
  const errors = [];
  let opened = 0;
  const ctx = {
    event: {
      subscribe({ signal }) {
        opened += 1;
        const round = opened;
        return (async function* () {
          if (round === 1) return; // the stream just ends
          if (round === 2) throw new Error("connection lost");
          yield { type: "shell.created", round };
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        })();
      },
    },
  };
  const done = follow(ctx, ["shell.created"], controller.signal, (event) => seen.push(event), (error) => errors.push(error.message), { firstDelay: 1 });
  await keepingAlive(async () => {
    const deadline = Date.now() + 5000;
    while (!seen.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.deepEqual(seen, [{ type: "shell.created", round: 3 }]);
  assert.deepEqual(errors, ["connection lost"]);
  assert.equal(opened, 3);
  controller.abort();
  await done;
  assert.equal(opened, 3, "nothing is reopened after the abort");
});
