import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { nativeMacTarget } from "./build-desktop";

const rootDir = resolve(import.meta.dir, "../..");

export function parseDesktopDevPorts(args: string[]): { backendPort: number; frontendPort: number } {
  const ports = { backendPort: 8080, frontendPort: 5173 };
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inlineValue, extraValue] = args[index]!.split("=");
    const key = flag === "--backend-port" ? "backendPort" : flag === "--frontend-port" ? "frontendPort" : undefined;
    if (!key) throw new Error(`Unknown option: ${args[index]}`);
    const value = inlineValue ?? args[++index];
    const port = Number(value);
    if (extraValue !== undefined || !value || !/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${flag} requires a port from 1 to 65535.`);
    }
    ports[key] = port;
  }
  if (ports.backendPort === ports.frontendPort) throw new Error("Backend and frontend ports must differ.");
  return ports;
}

export async function assertPortAvailable(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", (error) => reject(new Error(`Port ${port} is unavailable; choose another development port.`, { cause: error })));
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

/** Binding a port precedes bootstrap; HTTP 200 alone does not mean the backend is ready. */
export async function waitForEndpoint(
  url: string,
  signal: AbortSignal,
  backend = false,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
    }).catch(() => undefined);
    signal.throwIfAborted();
    if (response?.ok) {
      if (!backend) {
        await response.body?.cancel();
        return;
      }
      const status = await response.json() as { ready?: boolean; failed?: boolean; error?: string };
      if (status.failed === true) throw new Error(`Backend bootstrap failed: ${status.error || "unknown error"}`);
      if (status.ready === true) return;
    } else {
      await response?.body?.cancel();
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}${backend ? " to report ready=true" : ""}.`);
}

/** Each child starts its own group, so cleanup cannot touch an unrelated port owner. */
export async function stopProcessGroups(children: ChildProcess[], graceMs = 5_000): Promise<void> {
  const pending = new Set(children.flatMap((child) => child.pid ? [child.pid] : []));
  const permissionErrors = new Map<number, NodeJS.ErrnoException>();

  function signalPending(signal: NodeJS.Signals | 0): void {
    for (const pgid of pending) {
      try {
        process.kill(-pgid, signal);
        permissionErrors.delete(pgid);
      } catch (error) {
        const failure = error as NodeJS.ErrnoException;
        if (failure.code === "ESRCH") {
          pending.delete(pgid);
          permissionErrors.delete(pgid);
        } else if (failure.code === "EPERM") {
          // Darwin also returns EPERM for groups containing only unreaped zombies.
          // Keep waiting for ESRCH; a persistent permission failure must still surface.
          permissionErrors.set(pgid, failure);
        } else {
          throw error;
        }
      }
    }
  }

  async function waitForExit(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pending.size > 0) {
      signalPending(0);
      if (pending.size === 0 || Date.now() >= deadline) return;
      await Bun.sleep(50);
    }
  }

  signalPending("SIGTERM");
  await waitForExit(graceMs);
  signalPending("SIGKILL");
  await waitForExit(1_000);
  if (pending.size > 0) {
    const details = [...pending].map((pgid) => {
      const error = permissionErrors.get(pgid);
      return `PGID ${pgid}: ${error ? `${error.code}: ${error.message}` : "still exists"}`;
    });
    throw new Error(`Process groups did not exit after SIGKILL: ${details.join("; ")}`);
  }
}

async function desktopDev(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Usage: bun run scripts/desktop-dev.ts [--backend-port 8080] [--frontend-port 5173]");
    console.log("RIKKAHUB_PC_DATA_DIR overrides the isolated development data directory.");
    return;
  }
  if (process.platform !== "darwin") throw new Error("This desktop development entry currently supports macOS.");
  const { backendPort, frontendPort } = parseDesktopDevPorts(process.argv.slice(2));
  await assertPortAvailable(backendPort);
  await assertPortAvailable(frontendPort);
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const dataDir = resolve(process.env.RIKKAHUB_PC_DATA_DIR || join(rootDir, "dist/macos-dev/pc-data"));
  const env = {
    ...process.env,
    RIKKAHUB_PC_DATA_DIR: dataDir,
    RIKKAHUB_ANALYTICS: "0",
    RIKKAHUB_DEV_BACKEND_URL: backendUrl,
    RIKKAHUB_DESKTOP_DEV_URL: frontendUrl,
  };
  const controller = new AbortController();
  const children: ChildProcess[] = [];
  let failure: Error | undefined;
  const stop = () => controller.abort();
  const stopped = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);

  function start(name: string, args: string[], cwd: string): void {
    controller.signal.throwIfAborted();
    console.log(`[desktop-dev] Starting ${name}.`);
    const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: "inherit" });
    children.push(child);
    child.once("error", (error) => {
      if (controller.signal.aborted) return;
      failure = new Error(`${name} failed to start: ${error.message}`, { cause: error });
      stop();
    });
    child.once("exit", (code, signal) => {
      if (controller.signal.aborted) return;
      if (name !== "Tauri" || code !== 0) failure = new Error(`${name} exited (${signal ?? code}).`);
      stop();
    });
  }

  console.log(`[desktop-dev] Data: ${dataDir}\n[desktop-dev] Backend: ${backendUrl}; frontend: ${frontendUrl}`);
  try {
    start("backend", ["--watch", "--no-clear-screen", "run", "server.ts", "--dev", "--strict-port", "--host", "127.0.0.1", "--port", String(backendPort)], join(rootDir, "pc-server"));
    await waitForEndpoint(`${backendUrl}/api/startup/status`, controller.signal, true);
    start("Vite", ["run", "dev", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], join(rootDir, "web-ui"));
    await waitForEndpoint(frontendUrl, controller.signal);
    // Source development owns the backend and Vite; a fresh checkout has no packaged artifacts.
    const devConfig = {
      build: { beforeDevCommand: "", devUrl: frontendUrl },
      bundle: { externalBin: [], resources: [] },
    };
    start("Tauri", ["run", "tauri", "dev", "--target", nativeMacTarget(), "--config", JSON.stringify(devConfig)], join(rootDir, "web-ui"));
    await stopped;
  } catch (error) {
    if (!controller.signal.aborted) failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    stop();
    console.log("[desktop-dev] Stopping owned processes.");
    await stopProcessGroups(children);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
  }
  if (failure) throw failure;
}

if (import.meta.main) {
  await desktopDev().catch((error) => {
    console.error(`[desktop-dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
