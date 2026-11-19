// Everything the watchdog does to the outside world: clocks, output files, processes, the log.

import { execFile } from "node:child_process";
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { parseProcesses } from "./core.js";

const PS_TIMEOUT = 5_000;

/**
 * log: path of a JSON-lines log file, or "" for none.
 * ps, psTimeout: the process lister and how long it may take (tests replace them).
 */
export function createIO({ log: logFile = "", ps: psCommand = "ps", psTimeout = PS_TIMEOUT } = {}) {
  let logReady;

  const ps = (args) =>
    new Promise((resolve, reject) => {
      execFile(
        psCommand,
        args,
        { env: { ...process.env, LC_ALL: "C" }, timeout: psTimeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout)),
      );
    });

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

    /** Every process: [{ pid, pgid, startedWall }]. */
    processes() {
      return ps(["-A", "-o", "pid=,pgid=,etime="]).then((text) => parseProcesses(text, Date.now()));
    },

    /** Command line of one process as ps prints it; "" when there is no such process. */
    argv(pid) {
      return ps(["-ww", "-o", "command=", "-p", String(pid)]).catch((error) => {
        // ps exits with 1 and prints nothing at all when the pid does not exist. Anything else,
        // a complaint on stderr included, is a failure and must not pass for "no such process".
        const silent = String(error?.stdout ?? "").trim() === "" && String(error?.stderr ?? "").trim() === "";
        if (error?.code === 1 && !error.killed && silent) return "";
        throw error;
      });
    },

    log(entry) {
      if (!logFile) return;
      logReady ??= mkdir(dirname(logFile), { recursive: true }).catch(() => {});
      void logReady.then(() => appendFile(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)).catch(() => {});
    },
  };
}
