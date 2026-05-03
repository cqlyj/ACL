/**
 * Tiny self-exit watchdog for child processes spawned by the demo's
 * coordinator (`server.ts`). The coordinator usually shuts children
 * down via SIGINT, but if it crashes or is `kill -9`'d the children
 * are reparented and would otherwise linger — we hit that exact bug
 * while debugging the example, where two evaluator processes ended up
 * racing for the same `JobSubmitted` event after a stale process from
 * a previous session was reparented.
 *
 * Implementation: capture the original parent pid at boot, then poll
 * it every {@link ORPHAN_POLL_MS}. The instant the process at that pid
 * is gone (either no longer exists OR has been replaced — we only
 * trust the pid we were started under), we exit.
 *
 * Earlier versions checked for `process.ppid === 1` to detect orphan
 * status. That breaks on WSL (and any environment where init runs at a
 * pid other than 1, e.g. Linux user-session managers); a child whose
 * coordinator exits gets reparented to the WSL `/init` at pid ~1608
 * and the `=== 1` check never fires. Using `kill(initialPpid, 0)` is
 * the portable way to ask "does that process still exist?".
 */
const ORPHAN_POLL_MS = 5_000;

export function exitWhenOrphaned(): void {
  const initialPpid = process.ppid;
  // Bun (and Node) sometimes report `ppid` as 0 inside the very early
  // boot window. Skip arming the watchdog when that happens — the
  // coordinator-supervised path is the only one that needs this guard,
  // and it always has a real ppid by the time the child runs user code.
  if (!initialPpid || initialPpid <= 1) return;

  setInterval(() => {
    try {
      // Signal 0 = "is the process alive". Throws ESRCH when it's not.
      process.kill(initialPpid, 0);
    } catch {
      process.stderr.write(
        `[watchdog] parent process (pid=${initialPpid}) exited; shutting down child\n`,
      );
      process.exit(0);
    }
  }, ORPHAN_POLL_MS).unref();
}
