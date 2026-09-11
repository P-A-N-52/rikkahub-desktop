import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RELEASE_REPOSITORY } from "../shared/release-source";
import { completionPath, downloadInstaller, probeCompletedInstaller, validateUpdateDownload, type UpdateDownload } from "./download";
import { UPDATE_R2_BASE } from "./releases";

const directories: string[] = [];
const fresh = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "rkh-update-test-"))); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const payload = new TextEncoder().encode("Local complete installer fixture\n");
const sha256 = createHash("sha256").update(payload).digest("hex");
const download: UpdateDownload = {
  releaseRepo: "fixture/rikkahub", version: "2.1.0-preview.2+build.7",
  target: { platform: "mac", architecture: "arm64", containerized: false },
  fileName: "Rikkahub_2.1.0-preview.2+build.7_mac_arm64.dmg",
  url: "https://github.com/fixture/rikkahub/releases/download/v2.1.0-preview.2%2Bbuild.7/Rikkahub_2.1.0-preview.2%2Bbuild.7_mac_arm64.dmg",
  expectedSize: payload.length, sha256,
};
const respond = (body: BodyInit | null, init?: ResponseInit) => Object.assign(async () => new Response(body, init), { preconnect: fetch.preconnect });
const noParts = (dir: string) => expect(readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([]);

describe("update download boundaries", () => {
  test("configured repository, version and exact architecture are accepted", () => {
    expect(() => validateUpdateDownload(download)).not.toThrow();
    expect(() => validateUpdateDownload({ ...download, releaseRepo: "Fixture/RikkaHub" })).not.toThrow();
    expect(() => validateUpdateDownload({ ...download, url: download.url.replace("fixture/rikkahub", "FIXTURE/RIKKAHUB") })).not.toThrow();
    const intelName = download.fileName.replace("arm64", "x64");
    expect(() => validateUpdateDownload({ ...download, target: { ...download.target, architecture: "x64" }, fileName: intelName, url: download.url.replace("arm64", "x64") })).not.toThrow();
  });
  test("untrusted repository, version, file, protocol and URL credentials are rejected", () => {
    for (const url of [
      download.url.replace("fixture/rikkahub", "other/rikkahub"),
      download.url.replace("/v2.1.0-preview.2%2Bbuild.7/", "/v9.0.0/"),
      download.url.replace("arm64.dmg", "x64.dmg"),
      download.url.replace("https:", "http:"),
      download.url.replace("github.com", "github.com.evil.invalid"),
      download.url.replace("github.com", "user:secret@github.com"),
      `${download.url}?redirect=https://example.org`, `${download.url}#fragment`,
      `https://release-assets.githubusercontent.com/${download.fileName}`,
    ]) expect(() => validateUpdateDownload({ ...download, url })).toThrow();
  });
  test("macOS cannot download another architecture, arbitrary file, or installer type", () => {
    for (const fileName of ["../update.dmg", "update.dmg", download.fileName.replace("arm64", "x64"), `${download.fileName}.exe`, `${download.fileName}.zip`]) {
      expect(() => validateUpdateDownload({ ...download, fileName })).toThrow();
    }
    expect(() => validateUpdateDownload({ ...download, target: { ...download.target, containerized: true } })).toThrow();
    expect(() => validateUpdateDownload({ ...download, expectedSize: -1 })).toThrow();
    expect(() => validateUpdateDownload({ ...download, sha256: "unverified" })).toThrow();
  });
  test("only upstream Windows builds use the exact R2 mirror object", () => {
    const fileName = "Rikkahub_2.1.0_x64-setup.exe";
    const win = { ...download, version: "2.1.0", releaseRepo: DEFAULT_RELEASE_REPOSITORY,
      target: { ...download.target, platform: "win" as const, architecture: "x64" }, fileName, url: `${UPDATE_R2_BASE}/${fileName}` };
    expect(() => validateUpdateDownload(win)).not.toThrow();
    expect(() => validateUpdateDownload({ ...win, releaseRepo: "fixture/rikkahub" })).toThrow();
    expect(() => validateUpdateDownload({ ...win, url: `${UPDATE_R2_BASE}/other.exe` })).toThrow();
    expect(() => validateUpdateDownload({ ...win, url: win.url.replace(new URL(UPDATE_R2_BASE).host, "other.r2.dev") })).toThrow();
  });
});

describe("complete installer cache and atomic downloads", () => {
  test("real local HTTP transfer commits bytes plus a matching receipt only after completion", async () => {
    const dir = fresh();
    const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(payload, { headers: { "content-length": String(payload.length) } }) });
    const progress: number[] = [];
    const request = ((_: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => fetch(`http://127.0.0.1:${service.port}/fixture`, { ...init, proxy: "" })) as typeof fetch;
    try {
      const result = await downloadInstaller(dir, download, { fetch: request, onProgress: (value) => {
        expect(existsSync(join(dir, download.fileName))).toBe(false);
        expect(existsSync(completionPath(join(dir, download.fileName)))).toBe(false);
        progress.push(value.percent);
      } });
      expect(result).toEqual({ path: join(dir, download.fileName), size: payload.length });
      expect(new Uint8Array(readFileSync(result.path))).toEqual(payload);
      expect(JSON.parse(readFileSync(completionPath(result.path), "utf8"))).toEqual({ schema: 1, releaseRepo: download.releaseRepo,
        version: download.version, platform: "mac", architecture: "arm64", fileName: download.fileName, size: payload.length, sha256 });
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((percent) => percent < 100)).toBe(true);
      expect(await probeCompletedInstaller(dir, download)).toBe(result.path);
      noParts(dir);
    } finally { service.stop(true); }
  });

  test("EOF without Content-Length can complete using the release asset size", async () => {
    const dir = fresh();
    const result = await downloadInstaller(dir, download, { fetch: respond(payload) });
    expect(await probeCompletedInstaller(dir, download)).toBe(result.path);
  });

  test("files with missing receipts, wrong metadata or modified bytes are not cached", async () => {
    const dir = fresh();
    const path = join(dir, download.fileName);
    writeFileSync(path, payload);
    expect(await probeCompletedInstaller(dir, download)).toBeNull();
    await downloadInstaller(dir, download, { fetch: respond(payload) });
    const receiptPath = completionPath(path);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    for (const change of [{ version: "2.1.0" }, { architecture: "x64" }, { platform: "win" }, { releaseRepo: "other/repo" }, { fileName: "other.dmg" }, { size: 1 }, { sha256: "0".repeat(64) }]) {
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, ...change }));
      expect(await probeCompletedInstaller(dir, download)).toBeNull();
    }
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(path, new Uint8Array(payload.length).fill(33));
    expect(await probeCompletedInstaller(dir, download)).toBeNull();
  });

  test("cache refuses symlink installers and receipts", async () => {
    const dir = fresh();
    const result = await downloadInstaller(dir, download, { fetch: respond(payload) });
    const saved = readFileSync(result.path);
    const external = join(fresh(), "external");
    writeFileSync(external, saved);
    rmSync(result.path);
    symlinkSync(external, result.path);
    expect(await probeCompletedInstaller(dir, download)).toBeNull();
    rmSync(result.path);
    writeFileSync(result.path, saved);
    const receiptPath = completionPath(result.path);
    const externalReceipt = `${external}.json`;
    writeFileSync(externalReceipt, readFileSync(receiptPath));
    rmSync(receiptPath);
    symlinkSync(externalReceipt, receiptPath);
    expect(await probeCompletedInstaller(dir, download)).toBeNull();
  });

  test("a symlink cache is rejected before writing but a data directory alias is supported", async () => {
    const base = fresh();
    const external = fresh();
    const cache = join(base, "updates");
    symlinkSync(external, cache);
    await expect(downloadInstaller(cache, download, { fetch: respond(payload) })).rejects.toThrow("symbolic link");
    expect(await probeCompletedInstaller(cache, download)).toBeNull();
    expect(readdirSync(external)).toEqual([]);
    rmSync(cache);
    const dataAlias = join(fresh(), "data-alias");
    symlinkSync(base, dataAlias);
    const result = await downloadInstaller(join(dataAlias, "updates"), download, { fetch: respond(payload) });
    expect(result.path).toBe(join(base, "updates", download.fileName));
    expect(await probeCompletedInstaller(join(dataAlias, "updates"), download)).toBe(result.path);
  });

  for (const [name, body, headers, match] of [
    ["empty body", new Uint8Array(), {}, "incomplete or empty"],
    ["truncated body", payload.slice(0, 3), { "content-length": String(payload.length) }, "incomplete or empty"],
    ["wrong advertised length", payload, { "content-length": String(payload.length + 1) }, "size does not match"],
    ["excess body", new Uint8Array(payload.length + 1), {}, "exceeds the expected size"],
    ["checksum mismatch", new Uint8Array(payload.length), {}, "checksum does not match"],
  ] as const) {
    test(`${name} never creates a completed installer`, async () => {
      const dir = fresh();
      await expect(downloadInstaller(dir, download, { fetch: respond(body, { headers }) })).rejects.toThrow(match);
      expect(readdirSync(dir)).toEqual([]);
      expect(await probeCompletedInstaller(dir, download)).toBeNull();
    });
  }

  test("read failure cleans partial bytes and preserves an existing completed installer", async () => {
    const dir = fresh();
    const result = await downloadInstaller(dir, download, { fetch: respond(payload) });
    const originalReceipt = readFileSync(completionPath(result.path), "utf8");
    let sent = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(payload.slice(0, 3)); }
      else controller.error(new Error("local connection interrupted"));
    } });
    await expect(downloadInstaller(dir, download, { fetch: respond(body) })).rejects.toThrow("local connection interrupted");
    expect(new Uint8Array(readFileSync(result.path))).toEqual(payload);
    expect(readFileSync(completionPath(result.path), "utf8")).toBe(originalReceipt);
    expect(await probeCompletedInstaller(dir, download)).toBe(result.path);
    noParts(dir);
  });

  test("canceling a live HTTP download closes the stream and removes only its partial files", async () => {
    const dir = fresh();
    const controller = new AbortController();
    let canceled = false;
    const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(payload.slice(0, 3)); }, cancel() { canceled = true; },
    })) });
    const request = ((_: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => fetch(`http://127.0.0.1:${service.port}/fixture`, { ...init, proxy: "" })) as typeof fetch;
    try {
      await expect(downloadInstaller(dir, download, { fetch: request, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow();
      for (let n = 0; n < 50 && !canceled; n++) await Bun.sleep(10);
      expect(canceled).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    } finally { service.stop(true); }
  });

  test("idle timeout aborts the network response and removes partial bytes", async () => {
    const dir = fresh();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(payload.slice(0, 3)); } });
    await expect(downloadInstaller(dir, download, { fetch: respond(body), idleTimeoutMs: 10 })).rejects.toThrow("下载停滞");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("non-success responses do not wait for or persist their error body", async () => {
    const dir = fresh();
    const body = new ReadableStream<Uint8Array>();
    await expect(downloadInstaller(dir, download, { fetch: respond(body, { status: 503 }) })).rejects.toThrow("HTTP 503");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("same-target concurrent download is rejected without disturbing the owner", async () => {
    const base = fresh();
    const dir = join(base, "updates");
    const alias = join(fresh(), "data-alias");
    symlinkSync(base, alias);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    const first = downloadInstaller(dir, download, { fetch: Object.assign(async () => { started(); await gate; return new Response(payload); }, { preconnect: fetch.preconnect }) });
    await start;
    await expect(downloadInstaller(join(alias, "updates"), download, { fetch: respond(payload) })).rejects.toThrow("already downloading");
    release();
    expect(await probeCompletedInstaller(dir, download)).toBeNull();
    const result = await first;
    expect(await probeCompletedInstaller(dir, download)).toBe(result.path);
    noParts(dir);
  });
});
