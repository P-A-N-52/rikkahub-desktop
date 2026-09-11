import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { commandOutput, inventory, sha256, type FileRecord } from "./build-provenance";
import { validateMacApp } from "./package-macos";
import type { DesktopTarget } from "../shared/desktop-targets";

async function nativeSmoke(app: string) {
  const executable = join(app, "Contents/MacOS/rikkahub");
  const families = JSON.parse(commandOutput([executable, "--list-system-fonts"], app)) as unknown;
  if (!Array.isArray(families) || !families.length || !families.every((family) => typeof family === "string")) throw new Error("Native CoreText helper did not return font families");
  const data = mkdtempSync(join(tmpdir(), "rikkahub-package-smoke-"));
  writeFileSync(join(data, "models-dev-cache.json"), "{}");
  const child = Bun.spawn([join(app, "Contents/MacOS/rikkahub-server"), "--port", "18620", "--no-open"], {
    env: { ...process.env, RIKKAHUB_PC_DATA_DIR: data, RIKKAHUB_RESOURCE_DIR: join(app, "Contents/Resources"),
      RIKKAHUB_FONT_HELPER: executable, RIKKAHUB_ANALYTICS: "0", RIKKAHUB_PARENT_PID: String(process.pid),
      RIKKAHUB_HOST: "127.0.0.1", RIKKAHUB_CONTAINER: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  let captured = "";
  let port = 0;
  const drain = (async () => {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      captured = (captured + decoder.decode(value, { stream: true })).slice(-4096);
      port ||= Number(captured.match(/RIKKAHUB_PORT:(\d+)/)?.[1] ?? 0);
    }
  })();
  let failure: unknown;
  try {
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      if (port) {
        const response = await fetch(`http://127.0.0.1:${port}/api/startup/status`, { proxy: "", signal: AbortSignal.timeout(1_000) }).catch(() => null);
        if (response?.ok && (await response.json() as { ready?: boolean }).ready) { ready = true; break; }
      }
      await Bun.sleep(50);
    }
    if (!ready) throw new Error(`Packaged sidecar failed native startup (exit=${child.exitCode})`);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { proxy: "", signal: AbortSignal.timeout(2_000) });
    if (!health.ok || !(await health.json() as { ok?: boolean }).ok) throw new Error("Packaged sidecar health check failed");
    const frontend = await fetch(`http://127.0.0.1:${port}/`, { proxy: "", signal: AbortSignal.timeout(2_000) });
    if (!frontend.ok || !(await frontend.text()).includes("<!DOCTYPE html>")) throw new Error("Packaged frontend did not load");
  } catch (error) {
    failure = error;
  } finally {
    let forcedKill = false;
    if (child.exitCode === null) child.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (child.exitCode === null) { forcedKill = true; child.kill("SIGKILL"); }
    }, 10_000);
    await child.exited;
    clearTimeout(timeout);
    const [, stderrText] = await Promise.all([drain, stderr]);
    const lockRetained = existsSync(join(data, "pc-server.lock"));
    if (failure || child.exitCode !== 0 || forcedKill || lockRetained) {
      const reason = failure instanceof Error ? failure.message : failure ? String(failure)
        : `Sidecar shutdown failed (exit=${child.exitCode}, forcedKill=${forcedKill}, lockRetained=${lockRetained})`;
      writeFileSync(join(data, "validation-failure.json"), `${JSON.stringify({
        reason, exitCode: child.exitCode, signal: child.signalCode, forcedKill, lockRetained,
        stdoutTail: captured, stderrTail: stderrText.slice(-4096),
      }, null, 2)}\n`);
      throw new Error(`${reason}; diagnostic data retained at ${data}`, { cause: failure });
    }
    rmSync(data, { recursive: true, force: true });
  }
  return { fontFamilies: families.length, sidecarReady: true, frontendLoaded: true, sidecarExitCode: child.exitCode };
}

export async function verifyMacBuild(manifestPath: string) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    target: DesktopTarget; signing: { mode: string }; app: { files: FileRecord[] };
    artifacts: { name: string; sha256: string }[];
  };
  const outputDir = dirname(manifestPath);
  for (const artifact of manifest.artifacts) {
    if (basename(artifact.name) !== artifact.name || sha256(readFileSync(join(outputDir, artifact.name))) !== artifact.sha256) throw new Error(`Artifact checksum mismatch: ${artifact.name}`);
  }
  const archive = manifest.artifacts.find((item) => item.name.endsWith(".app.zip"));
  if (!archive) throw new Error("App archive missing from manifest");
  const extracted = mkdtempSync(join(tmpdir(), "rikkahub-verify-zip-"));
  const mount = mkdtempSync(join(tmpdir(), "rikkahub-verify-dmg-"));
  let attached = false;
  try {
    commandOutput(["/usr/bin/ditto", "-x", "-k", join(outputDir, archive.name), extracted], outputDir);
    const app = join(extracted, "Rikkahub.app");
    const verified = validateMacApp(app, manifest.target);
    if (JSON.stringify(verified.files) !== JSON.stringify(manifest.app.files)) throw new Error("Archived app resource inventory mismatch");
    if (manifest.signing.mode !== "none") commandOutput(["/usr/bin/codesign", "--verify", "--deep", "--strict", app], outputDir);
    const smoke = await nativeSmoke(app);
    const dmg = manifest.artifacts.find((item) => item.name.endsWith(".dmg"));
    if (dmg) {
      commandOutput(["/usr/bin/hdiutil", "verify", join(outputDir, dmg.name)], outputDir);
      commandOutput(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, join(outputDir, dmg.name)], outputDir);
      attached = true;
      if (JSON.stringify(inventory(join(mount, "Rikkahub.app"))) !== JSON.stringify(manifest.app.files)) throw new Error("DMG app resource inventory mismatch");
    }
    console.log(JSON.stringify({ manifest: basename(manifestPath), archiveVerified: true, dmgVerified: Boolean(dmg), ...smoke }, null, 2));
  } finally {
    if (attached) commandOutput(["/usr/bin/hdiutil", "detach", mount], outputDir);
    rmSync(mount, { recursive: true, force: true });
    rmSync(extracted, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { await verifyMacBuild(resolve(process.argv[2] ?? "")); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
