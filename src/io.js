// Everything the watchdog does to the outside world: clocks, output files, the claims of guards, the
// log. It reads the liveness of a pid and never sends a signal.

import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where guards claim their ids: a directory only its owner can enter, with one part per server. */
export function defaultClaims(env = process.env) {
  const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "opencode-shell-watchdog", "claims");
}

/**
 * log: path of a JSON-lines log file, or "" for none.
 * claims: the directory under which every server keeps the claims of its own guards.
 */
export function createIO({ log: logFile = "", claims = defaultClaims() } = {}) {
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

    /**
     * Makes this server's own part of the claims directory. Returns its path, or null when it cannot
     * be used: then no command gets a kill limit. The parts of other servers are never touched:
     * nothing here can tell whether a server, or a guard of one of its commands, is still alive.
     */
    async prepareClaims(space) {
      const dir = join(claims, space);
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        return dir;
      } catch {
        return null;
      }
    },

    // A claim is two files next to each other: <claim>.pid, made by the guard, and <claim>.stop,
    // made here to tell that guard to stop its command.

    /** The pid a guard wrote when it made the claim, as text; null when nobody has made it (yet). */
    async readClaim(claim) {
      try {
        return (await readFile(`${claim}.pid`, "utf8")).trim();
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    /** Tells the guard that made the claim to stop its command. Fails when the claim does not exist. */
    async requestStop(claim) {
      await stat(`${claim}.pid`);
      await writeFile(`${claim}.stop`, "");
    },

    /** Takes a stop back, in case the guard has not seen it yet. */
    async cancelStop(claim) {
      await rm(`${claim}.stop`, { force: true });
    },

    /**
     * Removes a claim that is not needed any more; its guard, if still there, leaves. The stop goes
     * first, so that removing a claim never stops anything; both files are tried in any case.
     */
    async dropClaim(claim) {
      const stop = await rm(`${claim}.stop`, { force: true }).then(() => null, (error) => error);
      await rm(`${claim}.pid`, { force: true });
      if (stop) throw stop;
    },

    log(entry) {
      if (!logFile) return;
      logReady ??= mkdir(dirname(logFile), { recursive: true }).catch(() => {});
      void logReady.then(() => appendFile(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)).catch(() => {});
    },
  };
}
