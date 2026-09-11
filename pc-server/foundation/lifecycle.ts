/** Application work and shutdown have one lifetime, shared by every exit trigger. */
export class ServerWork {
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  get signal(): AbortSignal { return this.controller.signal; }
  get stopping(): boolean { return this.signal.aborted; }

  stop(): void {
    this.controller.abort(new DOMException("Server is shutting down", "AbortError"));
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const task = operation();
    this.active.add(task);
    void task.then(() => this.active.delete(task), () => this.active.delete(task));
    return task;
  }

  async drain(deadline: number): Promise<void> {
    while (this.active.size > 0) {
      await beforeDeadline(Promise.allSettled([...this.active]), deadline, "active work");
    }
  }
}

export const serverWork = new ServerWork();

/** Background continuations outlive their HTTP response and must be drained too. */
export function runBackgroundTask(operation: () => Promise<unknown>): void {
  if (serverWork.stopping) return;
  void serverWork.run(operation).catch((err) => {
    if (!serverWork.stopping) console.error("[background] task failed", err);
  });
}

export async function beforeDeadline<T>(task: Promise<T>, deadline: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase} did not finish before the shutdown deadline`)), Math.max(0, deadline - Date.now()));
      }),
    ]);
    if (Date.now() > deadline) throw new Error(`${phase} exceeded the shutdown deadline`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ShutdownResult { ok: boolean; failures: string[]; }

interface ShutdownOperations {
  stopWork(deadline: number): void;
  drainWork(deadline: number): Promise<void>;
  stopProcesses(deadline: number): Promise<void>;
  flushState(deadline: number): Promise<void>;
  onFailure(phase: string, error: unknown): void;
}

/** Starts synchronously and returns the same promise to HTTP, signals and watchdog. */
export function createShutdown(operations: ShutdownOperations): () => Promise<ShutdownResult> {
  let pending: Promise<ShutdownResult> | undefined;
  return () => {
    if (pending) return pending;
    const completion = Promise.withResolvers<ShutdownResult>();
    pending = completion.promise;
    const started = Date.now();
    const failures: string[] = [];
    const fail = (phase: string, err: unknown) => {
      failures.push(phase);
      operations.onFailure(phase, err);
    };
    // Closing sockets may fail synchronously. Admission still closes immediately,
    // while the remaining cleanup must get its chance and settle the shared promise.
    try { operations.stopWork(started + 8_000); } catch (err) { fail("stop work", err); }
    const attempt = async (phase: string, operation: () => Promise<void>, deadline: number) => {
      try {
        await beforeDeadline(operation(), deadline, phase);
      } catch (err) {
        fail(phase, err);
      }
    };
    // Process cancellation starts immediately, before waiting for request/generation finally.
    const processes = attempt("owned processes", () => operations.stopProcesses(started + 6_000), started + 6_000);
    void (async () => {
      await attempt("active work", () => operations.drainWork(started + 3_000), started + 3_000);
      await processes;
      await attempt("state flush", () => operations.flushState(started + 8_000), started + 8_000);
      completion.resolve({ ok: failures.length === 0, failures });
    })().catch(completion.reject);
    return pending;
  };
}

/** Installed only by server.ts; standalone library/test imports keep fetch unchanged. */
export function installShutdownFetchInterceptor(): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([callerSignal, serverWork.signal]) : serverWork.signal;
    return originalFetch(input, { ...init, signal });
  }, originalFetch);
}

/** A live PPID relationship proves identity without probing an unrelated/reused PID. */
export function desktopParentPid(value = process.env.RIKKAHUB_PARENT_PID, platform = process.platform, actualParent = process.ppid): number | null {
  if (platform !== "darwin" || value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 1) {
    throw new Error("RIKKAHUB_PARENT_PID must be a positive desktop parent PID greater than 1");
  }
  const expected = Number(value);
  if (expected !== actualParent) throw new Error("RIKKAHUB_PARENT_PID does not match the actual parent process");
  return expected;
}

export function watchDesktopParent(parentPid: number | null, onLost: () => void): () => void {
  if (parentPid === null) return () => {};
  const timer = setInterval(() => {
    if (process.ppid !== parentPid) {
      clearInterval(timer);
      onLost();
    }
  }, 250);
  timer.unref();
  return () => clearInterval(timer);
}
