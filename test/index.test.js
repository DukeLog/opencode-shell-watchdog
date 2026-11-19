// The plugin entry against a fake OpenCode context: what it registers, and what it leaves behind.

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import plugin from "../src/index.js";
import { guardLine, splitTag } from "../src/core.js";

// The plugin keeps the claims of guards under the state directory: give it one of its own here.
const STATE = mkdtempSync(join(tmpdir(), "watchdog-state-"));
process.env.XDG_STATE_HOME = STATE;
const CLAIMS = join(STATE, "opencode-shell-watchdog", "claims");
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
  assert.equal(instancesAt("/index-1")[0].claims, CLAIMS);
  assert.ok(existsSync(CLAIMS), "the claims directory is made at setup");
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
  const listed = await tool.execute({}, { sessionID: "ses_index" });
  assert.match(listed.content, /No shell command of this session is being watched/);

  await cleanup();
  assert.deepEqual(ctx.disposed.sort(), ["hook", "tool"]);
  assert.equal(instancesAt("/index-1").length, 0);
  assert.equal(ctx.streams[0].signal.aborted, true);
});

test("the hook gives every launch of a kill-limited command a tag of its own", async () => {
  const ctx = fakeContext({ directory: "/index-2" });
  const cleanup = await plugin.setup(ctx);
  try {
    const [{ run }] = ctx.hooks;
    const plain = { command: "./job.sh", shell: "/bin/zsh" };
    await run(plain);
    assert.equal(plain.command, "./job.sh", "no kill limit: the command is not touched");
    const directed = { command: "# watchdog: report=5m\n./job.sh", shell: "/bin/zsh" };
    await run(directed);
    assert.equal(directed.command, "# watchdog: report=5m\n./job.sh");

    const text = "# watchdog: kill-runtime=2h\n./job.sh";
    const first = { command: text, shell: "/bin/zsh" };
    const second = { command: text, shell: "/bin/zsh" };
    await run(first);
    await run(second);
    const tags = [splitTag(first.command), splitTag(second.command)];
    assert.match(tags[0].tag, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(tags[0].tag, tags[1].tag);
    assert.deepEqual(tags.map((split) => split.command), [text, text]);
    assert.deepEqual(first.command.split("\n").slice(1), [guardLine(tags[0].tag, CLAIMS), ...text.split("\n")]);

    // The already tagged text launched once more: the old tag is not taken over.
    const again = { command: first.command, shell: "/bin/zsh" };
    await run(again);
    assert.notEqual(splitTag(again.command).tag, tags[0].tag);
    assert.equal(again.command.match(/# shell-watchdog:/g).length, 1);
    assert.equal(splitTag(again.command).command, text);

    for (const split of [...tags, splitTag(again.command)]) assert.ok(sharedState().issued.has(split.tag));
  } finally {
    sharedState().issued.clear();
    await cleanup();
  }

  // After cleanup the hook of the old instance does nothing.
  const late = { command: "# watchdog: kill-runtime=2h\n./job.sh", shell: "/bin/zsh" };
  await ctx.hooks[0].run(late);
  assert.equal(late.command, "# watchdog: kill-runtime=2h\n./job.sh");
});

test("a kill limit from the plugin options tags every command", async () => {
  const ctx = fakeContext({ directory: "/index-3", options: { killRuntime: "6h" } });
  const cleanup = await plugin.setup(ctx);
  try {
    const event = { command: "./job.sh", shell: "/bin/bash" };
    await ctx.hooks[0].run(event);
    assert.equal(splitTag(event.command).command, "./job.sh");
    assert.notEqual(splitTag(event.command).tag, null);
    const off = { command: "# watchdog: kill-runtime=off\n./job.sh", shell: "/bin/bash" };
    await ctx.hooks[0].run(off);
    assert.equal(off.command, "# watchdog: kill-runtime=off\n./job.sh");
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
