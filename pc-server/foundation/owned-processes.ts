import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface ProcessShutdownOptions {
  /** Absolute deadline, in Date.now() milliseconds. */
  deadline: number;
}

interface OwnedChild {
  child: ChildProcess;
  pid: number;
  exited: boolean;
  members: Map<number, string>;
  identityError?: Error;
}

/** No arguments or environment are read: only process-group membership and birth time. */
function groupMembers(pgid: number): Map<number, string> {
  const result = spawnSync(process.platform === "darwin" ? "/bin/ps" : "ps", ["-axo", "pid=,pgid=,lstart="], { encoding: "utf8", timeout: 1_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot verify owned process group ${pgid}`, { cause: result.error });
  }
  const members = new Map<number, string>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match && Number(match[2]) === pgid) members.set(Number(match[1]), match[3]!);
  }
  return members;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** Only children created by this backend may enter this set; callers retain their handles. */
export class OwnedProcesses {
  private readonly children = new Set<OwnedChild>();
  private readonly bunChildren = new Set<BunChild>();
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private reapTimer?: ReturnType<typeof setInterval>;

  assertRunning(): void {
    if (this.stopping) throw new Error("Server is shutting down; new child processes are disabled");
  }

  /** Direct native utilities use Bun's retained child handle, not a process group. */
  trackBun(child: BunChild): void {
    this.bunChildren.add(child);
    const forget = () => { this.bunChildren.delete(child); };
    void child.exited.then(forget, forget);
    if (this.stopping) {
      void stopBunProcess(child, { deadline: Date.now() + 3_000 }).catch((error) => {
        console.warn("[process] Late native child cleanup failed", error);
      });
    }
  }

  track(child: ChildProcess): { kill(): void } {
    if (!child.pid) return { kill() {} };
    const owned: OwnedChild = { child, pid: child.pid, exited: false, members: new Map() };
    this.children.add(owned);
    const exited = () => {
      owned.exited = true;
      try {
        // The exit event belongs to the retained child handle, so this is the
        // handover from the leader to the descendants it left in its group.
        if (process.platform !== "win32") owned.members = groupMembers(owned.pid);
        this.refresh(owned);
      } catch (error) { owned.identityError = error as Error; }
    };
    child.once("exit", exited);
    child.once("error", exited);
    if (process.platform !== "win32") {
      // While the ChildProcess is alive its handle proves ownership. Capture the
      // remaining group at exit so background descendants outlive the leader safely.
      if (!this.reapTimer) {
        this.reapTimer = setInterval(() => {
          for (const entry of this.children) {
            if (!entry.exited) continue;
            try { this.refresh(entry); } catch (error) { entry.identityError = error as Error; }
          }
        }, 1_000);
        this.reapTimer.unref();
      }
    }
    const kill = () => {
      void this.stopChild(owned, { deadline: Date.now() + 3_000 }, true).catch((error) => {
        console.warn(`[process] ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    if (this.stopping) kill();
    return { kill };
  }

  private forget(owned: OwnedChild): void {
    this.children.delete(owned);
    if (this.children.size === 0 && this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = undefined;
    }
  }

  /** ESRCH is the only successful POSIX terminal state, including zombie groups. */
  private refresh(owned: OwnedChild): boolean {
    if (!this.children.has(owned)) return false;
    if (process.platform === "win32") {
      if (owned.exited) this.forget(owned);
      return !owned.exited;
    }
    try { process.kill(-owned.pid, 0); } catch (error) {
      if (errorCode(error) === "ESRCH") { this.forget(owned); return false; }
      if (errorCode(error) !== "EPERM") throw error;
    }
    if (owned.exited) {
      if (owned.identityError) throw owned.identityError;
      const current = groupMembers(owned.pid);
      if (current.size > 0 &&
        ![...current].some(([pid, birth]) => owned.members.get(pid) === birth)) {
        throw new Error(`Ownership of process group ${owned.pid} changed; refusing to signal it`);
      }
      // Darwin may briefly expose no ps rows while kill(0) still reports EPERM.
      // Keep the previous identity until the kernel confirms ESRCH.
      if (current.size > 0) owned.members = current;
    }
    return true;
  }

  private async stopChild(owned: OwnedChild, { deadline }: ProcessShutdownOptions, force = false): Promise<void> {
    if (!this.refresh(owned)) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(owned.pid)], { stdio: "ignore", windowsHide: true });
      const killed = new Promise<void>((resolve, reject) => {
        killer.once("error", reject);
        killer.once("exit", (code) => code === 0 || owned.exited ? resolve() : reject(new Error(`taskkill failed for ${owned.pid}: ${code}`)));
      });
      await waitUntil(killed, { deadline }, `taskkill for ${owned.pid}`);
    } else {
      let sentKill = force;
      const graceDeadline = Math.min(deadline, Date.now() + 350);
      let permissionError: unknown;
      const signal = (value: NodeJS.Signals) => {
        // Verify identity again before every signal, not merely at registration.
        if (!this.refresh(owned)) return;
        // No surviving identity was visible at leader exit. Only wait for ESRCH;
        // never adopt a later process that happens to use the same group number.
        if (owned.exited && owned.members.size === 0) return;
        try { process.kill(-owned.pid, value); permissionError = undefined; } catch (error) {
          if (errorCode(error) === "ESRCH") this.forget(owned);
          else if (errorCode(error) === "EPERM") permissionError = error;
          else throw error;
        }
      };
      signal(force ? "SIGKILL" : "SIGTERM");
      while (this.refresh(owned)) {
        if (Date.now() >= deadline) {
          throw new Error(`Owned process group ${owned.pid} did not disappear before shutdown deadline${permissionError ? ` (${errorCode(permissionError)})` : ""}`, { cause: permissionError });
        }
        if (!sentKill && Date.now() >= graceDeadline) { sentKill = true; signal("SIGKILL"); }
        await Bun.sleep(Math.min(30, Math.max(1, deadline - Date.now())));
      }
      return;
    }
    while (this.refresh(owned)) {
      if (Date.now() >= deadline) throw new Error(`Owned process ${owned.pid} did not exit before shutdown deadline`);
      await Bun.sleep(20);
    }
  }

  shutdown(options: ProcessShutdownOptions): Promise<void> {
    this.stopping = true;
    return this.shutdownPromise ??= (async () => {
      const results = await Promise.allSettled([
        ...[...this.children].map((child) => this.stopChild(child, options)),
        ...[...this.bunChildren].map((child) => stopBunProcess(child, options)),
      ]);
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Owned child processes did not stop cleanly");
    })();
  }
}

/** A deadline must reject rather than leave shutdown waiting on an unbounded child. */
export async function waitUntil<T>(promise: Promise<T>, { deadline }: ProcessShutdownOptions, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded deadline`)), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type BunChild = Pick<Bun.Subprocess, "pid" | "exitCode" | "exited" | "kill">;

/** Bun retains the native child handle; never signal a saved bare PID after exit. */
export async function stopBunProcess(child: BunChild, { deadline }: ProcessShutdownOptions): Promise<void> {
  let exited = child.exitCode !== null;
  const done = child.exited.then(() => { exited = true; });
  const signal = (value: NodeJS.Signals) => {
    if (exited) return;
    try { child.kill(value); } catch (error) { if (errorCode(error) !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  try {
    await waitUntil(done, { deadline: Math.min(deadline, Date.now() + 350) }, `Child ${child.pid}`);
    return;
  } catch (error) {
    if (exited) throw error;
  }
  signal("SIGKILL");
  await waitUntil(done, { deadline }, `Child ${child.pid}`);
}

const ownedProcesses = new OwnedProcesses();
export const assertProcessSpawningAllowed = () => ownedProcesses.assertRunning();
export const trackOwnedProcess = (child: ChildProcess) => ownedProcesses.track(child);
export const trackOwnedBunProcess = (child: BunChild) => ownedProcesses.trackBun(child);
export const shutdownOwnedProcesses = (options: ProcessShutdownOptions) => ownedProcesses.shutdown(options);
