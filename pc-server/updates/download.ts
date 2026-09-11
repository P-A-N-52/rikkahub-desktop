import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readWithIdleTimeout } from "../foundation/net";
import { DEFAULT_RELEASE_REPOSITORY } from "../shared/release-source";
import { macInstallerName, normalizeReleaseVersion, UPDATE_R2_BASE, type UpdateTarget } from "./releases";

export interface UpdateDownload {
  releaseRepo: string;
  version: string;
  target: UpdateTarget;
  fileName: string;
  url: string;
  expectedSize: number;
  sha256?: string;
}

export interface CompletedInstaller {
  schema: 1;
  releaseRepo: string;
  version: string;
  platform: UpdateTarget["platform"];
  architecture: string;
  fileName: string;
  size: number;
  sha256: string;
}

export function validateUpdateDownload(download: UpdateDownload): void {
  const { fileName, target, version } = download;
  if (target.containerized) throw new Error("容器化部署不支持下载应用更新");
  if (normalizeReleaseVersion(version) !== version) throw new Error("Release version must be normalized");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(fileName)) throw new Error("Invalid update filename");
  const expectedName = target.platform === "mac" ? macInstallerName(version, target.architecture) : null;
  if (target.platform === "mac" ? !expectedName || fileName !== expectedName
    : target.platform === "win" ? !/\.exe$/i.test(fileName) : !/\.tar\.gz$/i.test(fileName)) {
    throw new Error("Update asset does not match the current platform and architecture");
  }
  if (!Number.isSafeInteger(download.expectedSize) || download.expectedSize < 0) throw new Error("Invalid update size");
  if (download.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(download.sha256)) throw new Error("Invalid update checksum");
  const url = new URL(download.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw new Error("Invalid update URL");
  const mirror = new URL(UPDATE_R2_BASE);
  if (target.platform === "win" && download.releaseRepo.toLowerCase() === DEFAULT_RELEASE_REPOSITORY.toLowerCase()
    && url.origin === mirror.origin && decodeURIComponent(url.pathname) === `/${fileName}`) return;
  const parts = decodeURIComponent(url.pathname).split("/");
  if (url.origin !== "https://github.com" || `${parts[1]}/${parts[2]}`.toLowerCase() !== download.releaseRepo.toLowerCase()
    || parts[3] !== "releases" || parts[4] !== "download") throw new Error("Update URL is outside the configured release repository");
  if (parts.length !== 7 || normalizeReleaseVersion(parts[5]!) !== version || parts[6] !== fileName) {
    throw new Error("Update URL does not match the release version and asset");
  }
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function completionPath(path: string): string { return `${path}.completed.json`; }

function cacheDirectory(directory: string): string {
  // dataDir may itself be an intentional alias; its updates child must be a real directory.
  if (!lstatSync(directory).isDirectory()) throw new Error("Update cache must be a directory, not a symbolic link");
  return realpathSync(directory);
}

/** Legacy files, partial writes, wrong architectures and modified files are never installers. */
export async function probeCompletedInstaller(directory: string, download: UpdateDownload): Promise<string | null> {
  try {
    validateUpdateDownload(download);
    const path = join(cacheDirectory(directory), download.fileName);
    const stat = lstatSync(path);
    const receiptFile = completionPath(path);
    const receiptStat = lstatSync(receiptFile);
    if (!stat.isFile() || !receiptStat.isFile() || stat.size <= 0 || receiptStat.size > 4096) return null;
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as CompletedInstaller;
    if (receipt.schema !== 1 || receipt.releaseRepo !== download.releaseRepo || receipt.version !== download.version
      || receipt.platform !== download.target.platform || receipt.architecture !== download.target.architecture
      || receipt.fileName !== download.fileName || receipt.size !== stat.size
      || (download.expectedSize > 0 && stat.size !== download.expectedSize)
      || !/^[a-f0-9]{64}$/.test(receipt.sha256)
      || (download.sha256 && receipt.sha256 !== download.sha256)) return null;
    if (await fileSha256(path) !== receipt.sha256) return null;
    const after = lstatSync(path);
    return after.isFile() && after.ino === stat.ino && after.size === stat.size && after.mtimeMs === stat.mtimeMs
      && after.ctimeMs === stat.ctimeMs ? path : null;
  } catch { return null; }
}

interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { loaded: number; total: number; percent: number }) => void;
  fetch?: typeof fetch;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

const activeDownloads = new Set<string>();

/** The final filename is visible only after EOF, size/checksum checks and a closed file. */
export async function downloadInstaller(directory: string, download: UpdateDownload, options: DownloadOptions = {}) {
  validateUpdateDownload(download);
  mkdirSync(directory, { recursive: true });
  const targetPath = join(cacheDirectory(directory), download.fileName);
  if (activeDownloads.has(targetPath)) throw new Error("This update is already downloading");
  activeDownloads.add(targetPath);
  const id = randomUUID();
  const partPath = `${targetPath}.${id}.part`;
  const receiptPart = `${completionPath(targetPath)}.${id}.part`;
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    signal.throwIfAborted();
    const response = await readWithIdleTimeout(
      () => (options.fetch ?? fetch)(download.url, {
        redirect: "follow", headers: { "User-Agent": "RikkaHub-PC", "Accept-Encoding": "identity" }, signal,
      }), options.connectTimeoutMs ?? 30_000, "下载连接超时：30s 内未收到服务器响应",
    );
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const contentLength = response.headers.get("content-length");
    const advertisedSize = contentLength === null ? 0 : Number(contentLength);
    if (!Number.isSafeInteger(advertisedSize) || advertisedSize < 0) throw new Error("Invalid download Content-Length");
    if (download.expectedSize > 0 && advertisedSize > 0 && advertisedSize !== download.expectedSize) {
      throw new Error("Download size does not match the release asset");
    }
    const total = download.expectedSize || advertisedSize;
    reader = response.body.getReader();
    file = await open(partPath, "wx", 0o600);
    const hash = createHash("sha256");
    let received = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await readWithIdleTimeout(() => reader!.read(), options.idleTimeoutMs ?? 60_000,
        "下载停滞：60s 未收到任何数据，已中断（网络或下载源异常，请重试）");
      if (done) break;
      received += value.length;
      if (total > 0 && received > total) throw new Error("Download exceeds the expected size");
      await file.writeFile(value);
      hash.update(value);
      options.onProgress?.({ loaded: received, total, percent: total > 0 ? Math.min(99, Math.round(received / total * 100)) : 0 });
    }
    signal.throwIfAborted();
    if (received === 0 || (download.expectedSize > 0 && received !== download.expectedSize)
      || (contentLength !== null && received !== advertisedSize)) throw new Error("Download is incomplete or empty");
    const sha256 = hash.digest("hex");
    if (download.sha256 && download.sha256 !== sha256) throw new Error("Download checksum does not match the release asset");
    await file.sync();
    await file.close();
    file = undefined;
    const receipt: CompletedInstaller = {
      schema: 1, releaseRepo: download.releaseRepo, version: download.version,
      platform: download.target.platform, architecture: download.target.architecture,
      fileName: download.fileName, size: received, sha256,
    };
    await writeFile(receiptPart, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();
    renameSync(partPath, targetPath);
    renameSync(receiptPart, completionPath(targetPath));
    return { path: targetPath, size: received };
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => {});
    await file?.close().catch(() => {});
    rmSync(partPath, { force: true });
    rmSync(receiptPart, { force: true });
    activeDownloads.delete(targetPath);
  }
}
