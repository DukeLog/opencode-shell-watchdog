// opencode-shell-watchdog — OpenCode V2 server plugin.
//
// A shell command left running in the background wakes its session only when it exits. This plugin
// watches the output of every command an agent starts and, when one goes silent or keeps repeating
// itself, tells the session what it sees. The agent decides what to do; nothing is killed unless a kill
// limit was given for that command when it was launched.

import { randomUUID } from "node:crypto";
import { parseOptions } from "./core.js";
import { createIO } from "./io.js";
import { follow } from "./stream.js";
import { addInstance, beforeCreate, handleEvent, removeInstance, sharedState, tick, toolCall } from "./watchdog.js";

const EVENTS = ["shell.created", "shell.exited", "shell.deleted", "session.deleted"];

// Code Mode shows only the first paragraph of a description, cut at about 500 characters. Everything
// the model has to know before it launches a command is therefore said there, and briefly.
const TOOL_DESCRIPTION = `Watches shell commands you leave running: when one goes silent or repeats its output, a "[shell-watchdog]" message arrives and you decide to wait or stop it. Set limits at launch with a comment line under a first comment naming the job: "# watchdog: report=5m" (status every 5m), "# watchdog: silence=30m", "# watchdog: kill-runtime=2h kill-silence=20m" (auto-kill, launch only), "# watchdog: off". Call with no arguments to list watched commands, or with "id" to change limits.

Every shell command you start is watched. Nothing is killed automatically unless a kill limit was given at launch.

A command with limits looks like this. Lists of running commands show the first line of a command, so that line names the job:
# nightly build of the docs
# watchdog: report=10m silence=off
./build.sh
The "# watchdog:" line counts anywhere among the comment lines the command opens with, the very first line included, and nowhere below them. A command that prints nothing until it ends (output sent to a file, a result only at the end) needs "silence=off" or a "silence" longer than its run.

Settings, in the "# watchdog:" line (name=value, separated by spaces) or as arguments of this tool:
- silence: report when nothing happens for this long ("5m", "90s", "1h30m"); "off" stops stall reports
- loop: what counts as "something happened" - "exact" (a line not printed recently), "shape" (same, ignoring numbers), "off" (any output)
- report: a status report at this interval whatever the command is doing; "off" to stop
- kill-silence, kill-runtime: stop the command after this long without output / of runtime; only at launch, and this tool can then change them or switch them off
Arguments of this tool only:
- snooze: no reports for this long, then one check
- off: true - stop watching the command`;

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

export default {
  id: "shell-watchdog",

  async setup(ctx) {
    const { options, settings, errors } = parseOptions(ctx.options);
    const io = createIO({ log: options.log });
    for (const error of errors) console.warn(`[shell-watchdog] option ignored: ${error}`);

    const state = sharedState();
    const inst = {
      ctx,
      io,
      options,
      settings,
      dir: ctx.location?.directory,
      workspace: ctx.location?.workspaceID ?? null,
      claims: null,
      disposed: false,
    };
    const controller = new AbortController();
    const registrations = [];
    let timer;

    const cleanup = async () => {
      removeInstance(state, inst);
      clearInterval(timer);
      controller.abort();
      for (const registration of registrations.splice(0)) {
        await Promise.resolve()
          .then(() => registration?.dispose?.())
          .catch(() => {});
      }
      io.log({ kind: "cleanup", dir: inst.dir });
    };

    try {
      // Where the guards of kill-limited commands make their claims: a directory of this server
      // process alone. Without it nothing gets a limit.
      state.space ??= randomUUID();
      inst.claims = await io.prepareClaims(state.space);

      // A command launched with a kill limit gets a guard with an id of its own in front of it.
      registrations.push(await ctx.shell.hook("create.before", (event) => beforeCreate(state, io, inst, event, randomUUID)));

      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "watchdog",
            description: TOOL_DESCRIPTION,
            input: TOOL_INPUT,
            // Keep it where the model sees it without searching: the description is how the model
            // learns the launch-time syntax.
            options: { pinned: true },
            execute: async (input, context) => ({ content: await toolCall(state, io, inst, input, context.sessionID) }),
          });
        }),
      );

      addInstance(state, io, inst);
      io.log({ kind: "setup", dir: inst.dir, version: ctx.app?.version ?? null, optionErrors: errors });

      void follow(
        ctx,
        EVENTS,
        controller.signal,
        (event) => {
          try {
            handleEvent(state, io, event);
          } catch (error) {
            io.log({ kind: "event-error", type: event?.type, error: String(error?.message ?? error) });
          }
        },
        (error) => io.log({ kind: "subscribe-error", error: String(error?.message ?? error) }),
      );

      timer = setInterval(() => {
        tick(state, io, inst).catch((error) => io.log({ kind: "tick-error", error: String(error?.stack ?? error) }));
      }, options.tick);
      timer.unref?.();
    } catch (error) {
      // Nothing may stay behind when the plugin fails to load: no instance, hook, timer or stream.
      await cleanup();
      throw error;
    }

    return cleanup;
  },
};
