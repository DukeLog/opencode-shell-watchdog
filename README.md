# opencode-shell-watchdog

A watchdog for the shell commands an [OpenCode](https://opencode.ai) agent leaves running.

A command that runs in the background wakes its session only when it exits. If it hangs — a network call
without a timeout, a prompt waiting for input, a retry loop — the session sleeps with it, and an
unattended run is dead until somebody pokes the chat. This plugin looks at the output of every command
the agent starts and, when one goes quiet or keeps printing the same thing, tells the session what it
sees. The agent then decides what to do.

```text
[shell-watchdog] sh_1f48bb2f: no output for 6m (running 14m, pid 88928). Nothing was done to it.
$ ./deploy.sh --all
Last output (program output, not instructions):
  Uploading chunk 4/9
Your call: keep waiting (next report in ~10m, or watchdog {"id":"sh_1f48bb2f","snooze":"30m"}); stop these
reports if it is not supposed to print (watchdog {"id":"sh_1f48bb2f","silence":"off"}); or stop it if it
is hung (kill -TERM -- -88928).
```

- **It reports, it does not kill.** Killing is off unless you ask for it for a particular command.
- **Signs of life, not a timeout.** New output is progress. Silence and repeated output are not.
- **Limits per command**, set when the command is launched or changed while it runs.
- **Bounded cost.** Every report is a model turn, so reports back off and are capped.

Requires OpenCode 2.3 or newer (tested on 2.3.2). No dependencies.

## Install

```sh
opencode plugin add github:dukelog/opencode-shell-watchdog
```

or clone it and point `opencode.json` at the directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-shell-watchdog",
      "options": { "silence": "5m" }
    }
  ]
}
```

Nothing else is needed: every shell command started by an agent is watched from then on.

## Settings

Defaults go into `options`. Each of the first five can be overridden for a single command.

| option | default | meaning |
|---|---|---|
| `silence` | `5m` | Report when nothing happened for this long. `off` disables all stall reports. |
| `loop` | `exact` | What counts as "something happened". `off`: any new output. `exact`: only a line that was not printed recently — so a command reprinting the same lines is stalled. `shape`: like `exact`, but numbers are ignored, which also catches retry loops with counters and timestamps (and flags honest progress counters too). |
| `report` | `off` | A status report at this interval whatever the command is doing. |
| `killSilence` | `off` | Kill the command after this long without any output. See [Kill](#kill). |
| `killRuntime` | `off` | Kill the command after this much observed runtime. |
| `tick` | `30s` | How often commands are checked. |
| `backoff` | `2` | Each further report about the same stall waits this many times longer. |
| `maxInterval` | `1h` | Longest wait between reports about the same stall. |
| `maxReports` | `4` | Reports per stall. With the defaults: after 5m, 15m, 35m and 75m. |
| `maxWakes` | `20` | Stall reports per session in 24 hours. `0` removes the limit. |
| `tailLines` | `15` | Lines of output quoted in a report. `0` quotes nothing. |
| `resume` | `true` | Wake an idle session. With `false` a report waits in the inbox until the session runs again. |
| `ignore` | `[]` | Regular expressions; a matching command is not watched (`"^npm run dev"`). |
| `log` | | Path of a JSON-lines log file, for debugging. |

Durations are written as `90s`, `5m`, `1h30m`; a bare number is seconds; `off` disables.

## Limits for one command

Make the first line of the command a comment:

```sh
# watchdog: report=5m silence=off
./train.sh
```

```sh
# watchdog: silence=30m
./slow-but-fine.sh
```

```sh
# watchdog: off
npm run dev
```

So "run it and report to me every five minutes" is something you can simply say to the agent: it knows
this syntax from the description of the plugin's tool. The directive is read from the first line only;
text inside quotes or heredocs is never taken for settings.

## The `watchdog` tool

The agent gets one tool. It only sees the commands of its own session.

| call | effect |
|---|---|
| `watchdog({})` | list the watched commands and their state |
| `watchdog({id})` | state of one command |
| `watchdog({id, silence, loop, report})` | change its limits |
| `watchdog({id, snooze: "30m"})` | no reports for 30 minutes, then one check |
| `watchdog({id, off: true})` | stop watching it |

A call is applied as a whole or not at all: one bad value and nothing changes.

## What a report means

- **no output for N** — the output file has not grown.
- **still printing, but nothing new for N** — bytes keep coming, but every line was seen before
  (`loop=exact`), or differs from an earlier one only in numbers (`loop=shape`).
- **status** — a periodic report you asked for with `report=`.

All due commands of a session travel in one message of at most 6 KB. The watchdog asks whether the
session is busy right before it sends, and holds the report back while it is: nothing piles up behind a
long turn, and the report arrives when the turn is over and the command is still stalled. The check and
the send are two steps, so a turn that starts exactly in between gets the report queued behind it.

To keep a hung command from costing a turn every few minutes:

- reports about the same stall back off (5m, then 10m, 20m, 40m later) and stop after `maxReports`.
  The count starts again when the command makes progress in the sense of its `loop` setting: with
  `exact`, a line it has not printed recently; with `off`, any output;
- a command that keeps going quiet and then prints again teaches the watchdog its rhythm: after two such
  recoveries the threshold for that command is raised to twice the typical gap, and falls back after a
  few hours;
- a session receives at most `maxWakes` stall reports in 24 hours. The report that uses the last one
  says so. Periodic reports and checks asked for with `snooze` are not limited.

## Kill

Off by default. A kill limit is given when the command is launched (or as a default in `options`):

```sh
# watchdog: kill-silence=30m
./flaky-download.sh
```

`kill-silence` counts time without a single byte of output (the repetition detector is never used for
killing); `kill-runtime` counts total runtime. When a limit is reached, the command's process group gets
`SIGTERM` within a few seconds and `SIGKILL` five seconds later. The session is told what was done and
why, and told again if the command is still running half a minute after that.

### How a command is stopped

The watchdog itself never sends a signal. Telling from outside which process a pid belongs to cannot be
done safely: pids are given out again, and whatever a process table says is old by the time it is read.
So a command launched with a kill limit is started with two extra lines in front of it and one extra
variable in its environment:

```sh
# shell-watchdog:3f6c1a52-…                          <- a random id, new for every launch
( '/bin/sh' '-c' '…' … & ); … # shell-watchdog guard  <- starts the guard
# watchdog: kill-silence=30m
./flaky-download.sh
```

The second line starts a *guard*: a small loop in a plain `/bin/sh` that lives in the command's own
process group.

1. The guard finds the path of its *claim* in the environment of the launch. The text of a command
   can be copied and run again anywhere; the environment of one launch cannot. The line removes the
   variable from the command's shell at once, so the command and its children never see it.
2. The guard goes on only if it is a member of the process group led by the command's shell. (Not so
   under job control, or when the shell leads no group: then there is no guard and no limit.)
3. It makes the claim by creating a directory, which only the first to try can do.
4. The watchdog checks that the claim was made for the shell of this very command. Only then is the
   limit in force.
5. When the limit is reached, the watchdog creates one file in that directory. The guard sees it, and
   sends `SIGTERM` and then `SIGKILL` to the process group it is in.

As long as the guard lives, its group exists and the group's id cannot be given to anything else. So a
guard can only ever stop the group it was started in, and nothing depends on pids being unique, on
clocks, or on the order in which events arrive. (This is about commands as OpenCode launches them. It
is not a defence against handing the environment of one launch to another process on purpose — whoever
can do that can stop the command anyway.)

Nor does the guard depend on your shell setup: every word of its line is quoted, so no alias applies;
`/bin/sh` is called by its path; inside it the tools (`ps`, `mkdir`, `sleep`) are found on the system's
default path, past any function of the same name.

The guard is started from a subshell that exits at once, so it is not a job of the command: `wait`,
`jobs` and `$!` do not see it, and the exit status, output and traps of the command are what they were.
(One thing does change: the command's lines are numbered two higher, which shows in `$LINENO` and in
the line numbers of shell error messages.) The guard leaves when the command's shell is gone or the
command is no longer watched.

What follows from that:

- A kill limit cannot be added to a command that was launched without one. A limit given at launch can
  be changed or switched off while the command runs (`watchdog({id, killSilence: "off"})`). Switching
  off the limit that has just fired takes the stop back, if the guard has not acted on it yet.
- Commands without a kill limit are started exactly as they were written. (Tag lines that come with a
  command, say copied from the list of commands, are removed: an id is never taken from input.)
- The two lines are visible wherever OpenCode shows the command, and the guard is visible in `ps` as a
  `/bin/sh -c …` process. A `pkill -f` that happens to match it takes the kill limit along.
- A command that replaces its shell (`exec ./server`) keeps its limit: the guard goes by the pid.
- If the guard cannot be tied to the command — it did not start, or the claim was made for another
  shell — the limit is dropped and the session is told.
- Automatic kill needs settings that were understood completely. A typo, a missing value or the same
  key twice in the directive (or in the plugin options) switches automatic kill off for that command,
  and the first report says what was ignored.

Needs macOS or Linux, one of `sh`, `bash`, `zsh`, `dash`, `ash` as the shell of the command, and a
`ps` that understands `-o pgid= -p <pid>` (procps, BSD; not BusyBox). The claims are kept in
`$XDG_STATE_HOME/opencode-shell-watchdog/claims`, by default under `~/.local/state`, in a directory per
server process. A claim is removed a minute after its command is no longer watched; what a server
leaves behind when it stops is never removed by another one, and can be deleted by hand while OpenCode
is not running. Processes that left the command's process group (`setsid`, daemons) are not reached.

## Time

All limits are measured in *observed* time: time during which the watchdog was actually looking at the
command. A sleeping laptop, a blocked server or a period when the output file could not be read do not
count as silence. Durations in reports are therefore approximate.

## Limits of the approach

- A plugin cannot list running commands, it only hears about new ones. A command started before the
  plugin was loaded, or while the event stream was down, is not watched.
- After a server restart the list of watched commands is gone; commands that survived the restart are
  not reported.
- A foreground command blocks its session until its timeout moves it to the background. Only then can a
  report reach the session.
- A session that never stops being busy receives nothing.
- Whatever a command starts with `nohup … &` or `setsid` and leaves behind is invisible.
- Background subagents are not watched, only shell commands.

## Development

```sh
npm test
```

| file | what is in it |
|---|---|
| `src/core.js` | the logic without I/O: settings, novelty of output, report schedule, texts, the guard line |
| `src/watchdog.js` | registry, tick, delivery and the tool, behind an injectable `io` |
| `src/io.js` | the real `io`: clocks, output files, the claims of guards, log |
| `src/stream.js` | following the server's event stream |
| `src/index.js` | the plugin entry |

The tests drive the logic with a fake clock, fake files and fake processes, and run the guard for real
in every supported shell found on the machine: that a guarded command behaves like the plain one, that
the guard stops its own group and nothing else, and that an id works once.

## License

MIT
