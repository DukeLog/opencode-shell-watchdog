// opencode-shell-watchdog — OpenCode V2 server plugin.
//
// A shell command left running in the background wakes its session only when it exits. This plugin
// watches the output of every command an agent starts and, when one goes silent or keeps repeating
// itself, tells the session what it sees. The agent decides what to do; nothing is killed unless a kill
// limit was given for that command when it was launched.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { addTag, parseOptions, parseProcesses, wantsTag } from "./core.js";
import { addInstance, handleEvent, removeInstance, sharedState, tick, toolCall } from "./watchdog.js";

const EVENTS = ["shell.created", "shell.exited", "shell.deleted", "session.deleted"];
const PS_TIMEOUT = 5_000;

const TOOL_DESCRIPTION = `Watchdog for shell commands that keep running.

Every shell command you start is watched. When one prints nothing for a while, or keeps printing lines it has printed before, a "[shell-watchdog]" message arrives in this session with what the command is doing. You then decide: keep waiting, look closer, or stop it. The watchdog never kills a command unless a kill limit was given at launch.

Call this tool with no arguments to list the watched commands of this session, with "id" to see one, or with "id" and settings to change them:
- silence: report when nothing happens for this long ("5m", "90s", "1h30m"); "off" stops stall reports
- loop: what counts as "something happened" - "exact" (a line not printed recently), "shape" (same, ignoring numbers), "off" (any output)
- report: a status report at this interval whatever the state ("5m"); "off" to stop
- snooze: no reports for this long, then one check
- off: true - stop watching the command

Settings can also be given at launch by making the first line of the command a comment:
  # watchdog: report=5m silence=10m
  ./long-task.sh
Kill limits (kill-silence, kill-runtime) work only this way, e.g. "# watchdog: kill-runtime=2h". "# watchdog: off" starts a command unwatched.`;

const TOOL_INPUT = {
  type: "object",
  properties: {
    id: { type: "string", description: "Shell ID (sh_...). Omit to list the watched commands of this session." },
    silence: { type: "string", description: 'Stall threshold, e.g. "5m"; "off" disables stall reports.' },
    loop: { type: "string", enum: ["off", "exact", "shape"], description: "What counts as progress besides new bytes." },
    report: { type: "string", description: 'Interval of unconditional status reports, e.g. "5m"; "off" to stop.' },
    killSilence: { type: "string", description: 'Change or switch "off" a kill-silence limit given at launch.' },
    killRuntime: { type: "string", description: 'Change or switch "off" a kill-runtime limit given at launch.' },
    snooze: { type: "string", description: 'No reports for this long, then one check, e.g. "30m".' },
    off: { type: "boolean", description: "true: stop watching this command (no reports, no automatic kill)." },
  },
  additionalProperties: false,
};

function createIO(logFile) {
  let logReady;
  return {
    platform: process.platform,
    mono: () => performance.now(),
    wall: () => Date.now(),

    async stat(file) {
      const info = await stat(file);
      return { size: info.size, ino: info.ino };
    },

    async read(file, start, length) {
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },

    // EPERM means the process exists and belongs to someone else.
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    },

    groupAlive(pgid) {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    },

    signalGroup(pgid, signal) {
      process.kill(-pgid, signal);
    },

    processes() {
      return ps(["-A", "-o", "pid=,pgid=,etime="]).then((text) => parseProcesses(text, Date.now()));
    },

    argv(pid) {
      return ps(["-ww", "-o", "command=", "-p", String(pid)]);
    },

    log(entry) {
      if (!logFile) return;
      logReady ??= mkdir(dirname(logFile), { recursive: true }).catch(() => {});
      void logReady.then(() => appendFile(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)).catch(() => {});
    },
  };
}

function ps(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      args,
      { env: { ...process.env, LC_ALL: "C" }, timeout: PS_TIMEOUT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

async function follow(ctx, signal, onEvent, io) {
  let delay = 1000;
  while (!signal.aborted) {
    try {
      for await (const event of ctx.event.subscribe({ types: EVENTS, signal })) {
        delay = 1000;
        onEvent(event);
      }
    } catch (error) {
      if (signal.aborted) return;
      io.log({ kind: "subscribe-error", error: String(error?.message ?? error) });
    }
    if (signal.aborted) return;
    // The stream ended while we are alive: commands started meanwhile go unseen, so come back fast.
    await sleep(delay, signal);
    delay = Math.min(delay * 2, 30_000);
  }
}

export default {
  id: "shell-watchdog",

  async setup(ctx) {
    const { options, settings, errors } = parseOptions(ctx.options);
    const io = createIO(options.log);
    for (const error of errors) console.warn(`[shell-watchdog] option ignored: ${error}`);

    const state = sharedState();
    const inst = {
      ctx,
      options,
      settings,
      dir: ctx.location?.directory,
      workspace: ctx.location?.workspaceID ?? null,
      disposed: false,
    };
    addInstance(state, io, inst);
    io.log({ kind: "setup", dir: inst.dir, version: ctx.app?.version ?? null, optionErrors: errors });

    const controller = new AbortController();
    const registrations = [];

    void follow(
      ctx,
      controller.signal,
      (event) => {
        try {
          handleEvent(state, io, event);
        } catch (error) {
          io.log({ kind: "event-error", type: event?.type, error: String(error?.message ?? error) });
        }
      },
      io,
    );

    const timer = setInterval(() => {
      tick(state, io, inst).catch((error) => io.log({ kind: "tick-error", error: String(error?.stack ?? error) }));
    }, options.tick);
    timer.unref?.();

    // A command launched with a kill limit gets a unique first line. It ends up in the argv of exactly
    // that process, which is what later proves a pid still is the command and not a reused number.
    registrations.push(
      await ctx.shell.hook("create.before", (event) => {
        if (inst.disposed || typeof event?.command !== "string") return;
        if (wantsTag(event.command, event.shell, settings, io.platform)) event.command = addTag(event.command, randomUUID());
      }),
    );

    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "watchdog",
          description: TOOL_DESCRIPTION,
          input: TOOL_INPUT,
          execute: async (input, context) => ({ content: await toolCall(state, io, inst, input, context.sessionID) }),
        });
      }),
    );

    return async () => {
      removeInstance(state, inst);
      clearInterval(timer);
      controller.abort();
      for (const registration of registrations) await registration?.dispose?.().catch(() => {});
      io.log({ kind: "cleanup", dir: inst.dir });
    };
  },
};
