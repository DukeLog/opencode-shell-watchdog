// Everything the watchdog does to the outside world: clocks, output files, the claims of guards, the
// log. It reads the liveness of a pid and never sends a signal.

import { appendFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where guards claim their ids: a directory only its owner can enter. */
export function defaultClaims(env = process.env) {
  const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "opencode-shell-watchdog", "claims");
}

/**
 * log: path of a JSON-lines log file, or "" for none.
 * claims: the claims directory (tests use their own).
 */
export function createIO({ log: logFile = "", claims = defaultClaims() } = {}) {
  let logReady;
  const claim = (tag) => join(claims, tag);

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
     * Makes the claims directory. Returns its path for the guard lines, or null when it cannot be
     * used: then no command gets a kill limit. A path with a line break could not be put in a line.
     */
    async prepareClaims() {
      if (/[\r\n]/.test(claims)) return null;
      try {
        await mkdir(claims, { recursive: true, mode: 0o700 });
        return claims;
      } catch {
        return null;
      }
    },

    /** The pid a guard wrote when it claimed the id, as text; null when nobody has claimed it (yet). */
    async readClaim(tag) {
      try {
        return (await readFile(join(claim(tag), "pid"), "utf8")).trim();
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    /** Tells the guard that has claimed the id to stop its command. Fails when there is no claim. */
    async requestStop(tag) {
      await writeFile(join(claim(tag), "stop"), "");
    },

    /** Takes a stop back, in case the guard has not seen it yet. */
    async cancelStop(tag) {
      await rm(join(claim(tag), "stop"), { force: true });
    },

    /** Removes a claim that is not needed any more; its guard, if still there, leaves. */
    async dropClaim(tag) {
      await rm(claim(tag), { recursive: true, force: true });
    },

    /** Removes claims nobody can use any more: older than maxAge and not in `keep`. */
    async sweepClaims(keep, maxAge) {
      let names;
      try {
        names = await readdir(claims);
      } catch {
        return;
      }
      for (const name of names) {
        if (keep.has(name)) continue;
        try {
          const info = await stat(claim(name));
          if (Date.now() - info.mtimeMs > maxAge) await rm(claim(name), { recursive: true, force: true });
        } catch {
          // Gone meanwhile, or not ours to remove.
        }
      }
    },

    log(entry) {
      if (!logFile) return;
      logReady ??= mkdir(dirname(logFile), { recursive: true }).catch(() => {});
      void logReady.then(() => appendFile(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)).catch(() => {});
    },
  };
}
