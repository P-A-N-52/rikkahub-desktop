// backup/storage.ts — 远端备份存储客户端（WebDAV、S3 SigV4）
// 纪律：负责远端列表/上传/恢复/删除与连接测试；zip 生成与导入逻辑分别在 export.ts / import.ts。

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import type { S3Config, WebDavConfig } from "../foundation/types";
import { backupStamp } from "../foundation/utils";
import { tempDir } from "../foundation/platform";
import { stripXmlText } from "../files/index";
import { createSettingsBackupZipToPath } from "./export";
import { streamResponseToTempAndRestore } from "./import";

function webDavAuthHeader(config: WebDavConfig): Record<string, string> {
  return config.username || config.password
    ? { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` }
    : {};
}

function webDavUrl(config: WebDavConfig, fileName = "") {
  const base = config.url.trim().replace(/\/+$/, "");
  if (!base) throw new Error("WebDAV URL 为空");
  const parts = [config.path, fileName]
    .map((part) => String(part ?? "").trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .map((part) => part.split("/").map(encodeURIComponent).join("/"));
  return parts.length ? `${base}/${parts.join("/")}` : base;
}

async function webDavRequest(config: WebDavConfig, method: string, fileName = "", init: RequestInit & { timeoutMs?: number } = {}) {
  const headers: Record<string, string> = {
    ...webDavAuthHeader(config),
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  const timeoutMs = init.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    return await fetch(webDavUrl(config, fileName), { ...init, method, headers, signal: controller.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function webDavEnsureCollection(config: WebDavConfig) {
  const check = await webDavRequest(config, "PROPFIND", "", {
    headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body: "<D:propfind xmlns:D=\"DAV:\"><D:prop><D:resourcetype/></D:prop></D:propfind>",
  });
  if (check.ok || check.status === 207) return;
  const create = await webDavRequest(config, "MKCOL");
  if (!create.ok && create.status !== 405) {
    throw new Error(`WebDAV 创建目录失败：${create.status} ${(await create.text()).slice(0, 500)}`);
  }
}

// Wraps the current PC state in a zip that's:
//   1) cross-platform compatible — Android's S3Sync / WebDavSync importer reads
//      `settings.json` + `upload/<fileName>` + `skills/<name>/<...>` entries
//   2) PC lossless — an additional `pc-backup.json` entry carries the full PC state
//      (conversations, message tree, generatedImages, logs, etc.) WITHOUT inlining file
//      bytes as base64. The Android side simply ignores the unknown entry; the PC side
//      reads it on re-import for a full-fidelity round-trip.
//
// OOM safety: file bytes never go through the JS heap. PowerShell's Compress-Archive
// streams them directly from the staging dir into the zip. This is the difference between
// "exports a 5 GB attachment library cleanly" vs "OOM at JSON.stringify because we tried
// to base64 every file into a single string".
//
// Entries written:
//   settings.json          ← state.settings only (Android-compatible)
//   pc-backup.json         ← full PC state w/o file bytes (PC-only fast lossless path)
//   upload/<fileName>      ← raw file bytes for each state.files[]
//   skills/<name>/<...>    ← recursive copy of context.filesDir/skills/
//   (rikka_hub.db is intentionally absent — PC has no SQLite db.)

function parseWebDavItems(xml: string) {
  const blocks = xml.match(/<[^>]*response[\s\S]*?<\/[^>]*response>/gi) ?? [];
  return blocks.map((block) => {
    const value = (name: string) => {
      const match = block.match(new RegExp(`<[^>]*(?:${name})[^>]*>([\\s\\S]*?)<\\/[^>]*(?:${name})>`, "i"));
      return match ? stripXmlText(match[1]) : "";
    };
    const href = value("href");
    // 5-7:畸形 href(如裸 %)会让 decodeURIComponent 抛 URIError,炸掉整个列表接口;退回原文。
    const rawName = href.replace(/\/$/, "").split("/").pop() ?? "";
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch { /* 保留原文 */ }
    const displayName = value("displayname") || decodedName;
    return {
      href,
      displayName,
      size: Number(value("getcontentlength")) || 0,
      lastModified: value("getlastmodified"),
      isCollection: /<[^>]*collection\b/i.test(block),
    };
  });
}

export async function webDavListBackups(config: WebDavConfig) {
  await webDavEnsureCollection(config);
  const response = await webDavRequest(config, "PROPFIND", "", {
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: "<D:propfind xmlns:D=\"DAV:\"><D:prop><D:displayname/><D:getcontentlength/><D:getlastmodified/><D:resourcetype/></D:prop></D:propfind>",
  });
  const text = await response.text();
  if (!response.ok && response.status !== 207) throw new Error(`WebDAV 列表失败：${response.status} ${text.slice(0, 500)}`);
  return parseWebDavItems(text)
    // Accept both .zip (current PC + Android format) and .json (legacy PC format) so users
    // who upgrade from an older PC version still see their old backups, and Android-origin
    // backups become visible in the PC list.
    .filter((item) => !item.isCollection && /^backup_.*\.(zip|json)$/i.test(item.displayName))
    .sort((a, b) => Date.parse(b.lastModified || "") - Date.parse(a.lastModified || ""));
}

export async function webDavBackup(config: WebDavConfig, onProgress?: (message: string, percent?: number) => void) {
  await webDavEnsureCollection(config);
  const fileName = `backup_${backupStamp()}.zip`;
  const tmpRoot = join(tempDir(), `rikkahub-webdav-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });
  const zipPath = join(tmpRoot, fileName);
  try {
    const { size } = createSettingsBackupZipToPath(zipPath, (msg) => onProgress?.(msg));
    onProgress?.("正在上传...", 0);
    const file = Bun.file(zipPath);
    let uploaded = 0;
    const progressStream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const reader = file.stream().getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ctrl.enqueue(value);
            uploaded += value.length;
            const pct = Math.round(uploaded / size * 100);
            onProgress?.(`正在上传 (${pct}%)`, pct);
          }
          ctrl.close();
        } catch (err) {
          ctrl.error(err);
        }
      },
    });
    const response = await webDavRequest(config, "PUT", fileName, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(size),
      },
      body: progressStream as unknown as BodyInit,
      timeoutMs: 0,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`WebDAV 备份失败：${response.status} ${text.slice(0, 500)}`);
    return { fileName, size };
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export async function webDavRestore(config: WebDavConfig, fileName: string, onProgress?: (message: string, percent?: number) => void) {
  onProgress?.("正在下载...", 0);
  const response = await webDavRequest(config, "GET", fileName, { timeoutMs: 0 });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WebDAV 下载失败：${response.status} ${text.slice(0, 500)}`);
  }
  await streamResponseToTempAndRestore(response, fileName, onProgress);
}

export async function webDavDelete(config: WebDavConfig, fileName: string) {
  const response = await webDavRequest(config, "DELETE", fileName);
  const text = await response.text();
  if (!response.ok) throw new Error(`WebDAV 删除失败：${response.status} ${text.slice(0, 500)}`);
}

// AWS Signature Version 4 — see https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html.
// Supports standard AWS S3 plus any S3-compatible endpoint (MinIO, R2, OSS, COS) by letting the
// caller override `endpoint` and `pathStyle`. The signer always emits `s3` as the service
// and `aws4_request` as the terminator, which is correct for both AWS and all major S3 clones.
function sha256Hex(payload: string | Buffer) {
  return createHash("sha256").update(payload).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string) {
  return createHmac("sha256", key).update(data).digest();
}

function awsUriEncode(value: string, encodeSlash: boolean) {
  let result = "";
  for (const ch of value) {
    if (/[A-Za-z0-9_.~\-]/.test(ch)) {
      result += ch;
    } else if (ch === "/") {
      result += encodeSlash ? "%2F" : "/";
    } else {
      const buf = Buffer.from(ch, "utf-8");
      for (const byte of buf) result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return result;
}

// endpoint 空 = 原生 AWS S3,"auto" 不是 AWS 认可的 region,host 与签名都需要真实 region;
// endpoint 非空 = S3 兼容服务(R2 / MinIO 等),它们对 region 宽容,"auto" 作为签名占位能被接受。
// 故仅当 endpoint 空且 region 为空/"auto" 时 fallback 到 us-east-1(AWS 通用默认,也是旧 PC 默认),
// 避免 host 拼成无效的 s3.auto.amazonaws.com、签名 scope 用 AWS 不认的 "auto"。
function effectiveS3Region(config: S3Config): string {
  const region = config.region.trim();
  if (!config.endpoint.trim() && (region === "" || region.toLowerCase() === "auto")) return "us-east-1";
  return region || "us-east-1";
}

function s3EndpointHost(config: S3Config) {
  const explicit = config.endpoint.trim().replace(/\/+$/, "");
  if (explicit) {
    const parsed = new URL(/^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`);
    return { protocol: parsed.protocol, host: parsed.host, base: `${parsed.protocol}//${parsed.host}` };
  }
  // endpoint 空 = 原生 AWS。region "auto" 对 AWS 无效,effectiveS3Region 已 fallback us-east-1。
  const host = `s3.${effectiveS3Region(config)}.amazonaws.com`;
  return { protocol: "https:", host, base: `https://${host}` };
}

function s3RequestUrl(config: S3Config, key: string, query: Record<string, string>) {
  const { base, host } = s3EndpointHost(config);
  const pathStyle = config.pathStyle;
  const path = key ? `/${awsUriEncode(key, false)}` : "/";
  const url = pathStyle ? `${base}/${config.bucket}${path}` : `${base.replace("//", `//${config.bucket}.`)}${path}`;
  const finalHost = pathStyle ? host : `${config.bucket}.${host}`;
  const sortedQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
  const canonicalQuery = sortedQuery.map(([k, v]) => `${awsUriEncode(k, true)}=${awsUriEncode(v, true)}`).join("&");
  const canonicalUri = pathStyle ? `/${awsUriEncode(config.bucket, false)}${path}` : path;
  return {
    requestUrl: canonicalQuery ? `${url}?${canonicalQuery}` : url,
    canonicalUri,
    canonicalQuery,
    host: finalHost,
  };
}

// `payloadHashOverride` opts the request into AWS's "UNSIGNED-PAYLOAD" SigV4 mode so the
// caller doesn't have to buffer the whole upload into memory just to compute SHA256.
// Required for the streaming-zip backup path — a user with multi-GB attachments would
// otherwise OOM here before the upload even started. Only safe over HTTPS (the AWS docs
// warn that an MITM could tamper with the body), which every S3-compatible endpoint we
// target requires anyway.
function s3Sign(config: S3Config, method: string, key: string, query: Record<string, string>, payload: Buffer, payloadHashOverride?: string) {
  if (!config.accessKeyId || !config.secretAccessKey) throw new Error("S3 凭据未配置");
  if (!config.bucket) throw new Error("S3 bucket 未配置");
  const { requestUrl, canonicalUri, canonicalQuery, host } = s3RequestUrl(config, key, query);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = payloadHashOverride ?? sha256Hex(payload);
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const region = effectiveS3Region(config);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    requestUrl,
    headers: { ...headers, Authorization: authorization },
  };
}

async function s3Request(
  config: S3Config,
  method: string,
  key: string,
  options: {
    query?: Record<string, string>;
    body?: Buffer;
    /** Streamed upload (ReadableStream from Bun.file().stream() etc.). When provided we
     *  switch SigV4 to UNSIGNED-PAYLOAD so we never read the whole upload into a Buffer. */
    bodyStream?: ReadableStream<Uint8Array>;
    bodyLength?: number;
    contentType?: string;
    timeoutMs?: number;
  } = {},
) {
  let payload: Buffer = Buffer.alloc(0);
  let payloadHashOverride: string | undefined;
  let bodyForFetch: BodyInit | undefined;
  let contentLength: string | undefined;
  if (options.bodyStream) {
    payloadHashOverride = "UNSIGNED-PAYLOAD";
    bodyForFetch = options.bodyStream as unknown as BodyInit;
    if (options.bodyLength != null) contentLength = String(options.bodyLength);
  } else {
    payload = options.body ?? Buffer.alloc(0);
    bodyForFetch = payload.length ? (payload as BodyInit) : undefined;
    if (payload.length) contentLength = String(payload.length);
  }
  const { requestUrl, headers } = s3Sign(config, method, key, options.query ?? {}, payload, payloadHashOverride);
  const finalHeaders: Record<string, string> = { ...headers };
  if (options.contentType) finalHeaders["Content-Type"] = options.contentType;
  if (contentLength) finalHeaders["Content-Length"] = contentLength;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    return await fetch(requestUrl, { method, headers: finalHeaders, body: bodyForFetch, signal: controller.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function s3Prefix() {
  // 对齐 APP:备份前缀硬编码(APP 无 config 字段,固定 rikkahub_backups/)。
  return "rikkahub_backups/";
}

export async function s3TestConnection(config: S3Config) {
  // HEAD on the bucket validates credentials + endpoint without listing.
  const response = await s3Request(config, "GET", "", { query: { "list-type": "2", "max-keys": "1" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`S3 测试失败：${response.status} ${text.slice(0, 500)}`);
}

export async function s3ListBackups(config: S3Config) {
  const prefix = `${s3Prefix()}backup_`;
  const items: Array<{ href: string; displayName: string; size: number; lastModified: string }> = [];
  // 5-7:ListObjectsV2 单页最多 1000 个对象,按 continuation-token 翻页,长期用户的
  // 备份列表不再截断。上限 50 页(5 万对象)防畸形响应死循环。
  let continuationToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const response = await s3Request(config, "GET", "", { query });
    const text = await response.text();
    if (!response.ok) throw new Error(`S3 列表失败：${response.status} ${text.slice(0, 500)}`);
    collectS3Contents(text, items);
    const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(text);
    const tokenMatch = text.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/i);
    if (!truncated || !tokenMatch) break;
    continuationToken = stripXmlText(tokenMatch[1]);
  }
  items.sort((a, b) => Date.parse(b.lastModified || "") - Date.parse(a.lastModified || ""));
  return items;
}

function collectS3Contents(text: string, items: Array<{ href: string; displayName: string; size: number; lastModified: string }>): void {
  // Minimal XML scan — S3 ListObjectsV2 has one <Contents> element per object.
  const blocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  for (const block of blocks) {
    const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/);
    const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
    const lastMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);
    if (!keyMatch) continue;
    const fileKey = keyMatch[1];
    const displayName = fileKey.split("/").pop() ?? fileKey;
    // Accept .zip (current cross-platform format) and .json (legacy PC backups).
    if (!/^backup_.*\.(zip|json)$/i.test(displayName)) continue;
    items.push({
      href: fileKey,
      displayName,
      size: Number(sizeMatch?.[1] ?? 0),
      lastModified: lastMatch?.[1] ?? "",
    });
  }
}

export async function s3Backup(config: S3Config, onProgress?: (message: string, percent?: number) => void) {
  const fileName = `backup_${backupStamp()}.zip`;
  const key = `${s3Prefix()}${fileName}`;
  const tmpRoot = join(tempDir(), `rikkahub-s3-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });
  const zipPath = join(tmpRoot, fileName);
  try {
    const { size } = createSettingsBackupZipToPath(zipPath, (msg) => onProgress?.(msg));
    onProgress?.("正在上传...", 0);
    const file = Bun.file(zipPath);
    let uploaded = 0;
    const progressStream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const reader = file.stream().getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ctrl.enqueue(value);
            uploaded += value.length;
            const pct = Math.round(uploaded / size * 100);
            onProgress?.(`正在上传 (${pct}%)`, pct);
          }
          ctrl.close();
        } catch (err) {
          ctrl.error(err);
        }
      },
    });
    const response = await s3Request(config, "PUT", key, {
      bodyStream: progressStream,
      bodyLength: size,
      contentType: "application/zip",
      timeoutMs: 0,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`S3 备份失败：${response.status} ${text.slice(0, 500)}`);
    return { fileName, size };
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export async function s3Restore(config: S3Config, fileName: string, onProgress?: (message: string, percent?: number) => void) {
  const key = `${s3Prefix()}${fileName}`;
  onProgress?.("正在下载...", 0);
  const response = await s3Request(config, "GET", key, { timeoutMs: 0 });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`S3 下载失败：${response.status} ${text.slice(0, 500)}`);
  }
  await streamResponseToTempAndRestore(response, fileName, onProgress);
}

export async function s3Delete(config: S3Config, fileName: string) {
  const key = `${s3Prefix()}${fileName}`;
  const response = await s3Request(config, "DELETE", key);
  const text = await response.text();
  if (!response.ok && response.status !== 204) throw new Error(`S3 删除失败：${response.status} ${text.slice(0, 500)}`);
}
