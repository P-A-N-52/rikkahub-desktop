// Application updates: platform-specific installers share verified atomic downloads.
import { serverWork } from "../../foundation/lifecycle";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { updatesCacheDir } from "../../foundation/paths";
import { RUNNING_IN_CONTAINER, RUNTIME_PLATFORM } from "../../foundation/platform";
import {
  APP_VERSION, RELEASE_REPOSITORY, discoverRelease, downloadInstaller, isNewerRelease,
  normalizeReleaseVersion, probeCompletedInstaller, readSkippedVersion, validateUpdateDownload,
  writeSkippedVersion, type UpdateDownload, type UpdateTarget,
} from "../../updates/index";
import { error, json, readJson, sseHeaders } from "../request";

const updateTarget: UpdateTarget = {
  platform: RUNTIME_PLATFORM, architecture: process.arch, containerized: RUNNING_IN_CONTAINER,
};

export async function handleUpdateRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "update/check" && request.method === "GET") {
    try {
      const metadata = await discoverRelease(RELEASE_REPOSITORY, updateTarget, APP_VERSION);
      const isNewer = isNewerRelease(metadata.latest, APP_VERSION);
      const isSkipped = isNewer && metadata.latest === readSkippedVersion();
      const download: UpdateDownload = {
        releaseRepo: RELEASE_REPOSITORY, version: metadata.latest, target: updateTarget,
        fileName: metadata.fileName, url: metadata.downloadUrl, expectedSize: metadata.size, sha256: metadata.sha256,
      };
      const cachedInstallerPath = isNewer && !isSkipped && !RUNNING_IN_CONTAINER && RUNTIME_PLATFORM !== "linux"
        ? await probeCompletedInstaller(updatesCacheDir, download) : null;
      return json({
        ...metadata, current: APP_VERSION, isNewer, isSkipped, platform: RUNTIME_PLATFORM,
        architecture: process.arch, releaseRepo: RELEASE_REPOSITORY, containerized: RUNNING_IN_CONTAINER,
        cachedInstallerPath,
      });
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : "检查更新失败", 502);
    }
  }
  if (path === "update/download" && request.method === "POST") {
    let download: UpdateDownload;
    try {
      const body = await readJson<{ url?: string; fileName?: string; version?: string; size?: number; sha256?: string }>(request);
      download = {
        releaseRepo: RELEASE_REPOSITORY, target: updateTarget,
        url: String(body.url ?? "").trim(), fileName: String(body.fileName ?? ""),
        version: normalizeReleaseVersion(String(body.version ?? "")), expectedSize: body.size ?? 0,
        sha256: body.sha256,
      };
      validateUpdateDownload(download);
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : "Invalid download request", 400);
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, request.signal, serverWork.signal]);
    const stream = new ReadableStream({
      start: (controller) => serverWork.run(async () => {
        const encoder = new TextEncoder();
        const send = (event: Record<string, unknown>) => {
          if (signal.aborted) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        try {
          const result = await downloadInstaller(updatesCacheDir, download, {
            signal, onProgress: (progress) => send({ type: "progress", ...progress }),
          });
          signal.throwIfAborted();
          if (RUNTIME_PLATFORM !== "linux") {
            // Windows opens NSIS; macOS opens this DMG and explains the manual replacement.
            send({ type: "done", ...result });
            return;
          }
          // Existing Linux package layout and apply route remain unchanged.
          const extractBase = download.fileName.replace(/\.tar\.gz$/i, "") || "rikkahub-pc";
          const extractDir = join(updatesCacheDir, `extracted-${extractBase}`);
          rmSync(extractDir, { recursive: true, force: true });
          mkdirSync(extractDir, { recursive: true });
          const tar = Bun.spawnSync(["tar", "xzf", result.path, "-C", extractDir]);
          if (tar.exitCode !== 0) throw new Error(`解压更新包失败：${tar.stderr?.toString().trim() || `tar exited ${tar.exitCode}`}`);
          const innerExe = join(extractDir, "rikkahub-pc", "rikkahub-pc");
          if (!existsSync(innerExe) || statSync(innerExe).size === 0) throw new Error("解压后未找到可执行文件（更新包结构异常）");
          chmodSync(innerExe, 0o755);
          send({ type: "done", path: innerExe, size: result.size });
        } catch (cause) {
          if (!signal.aborted) send({ type: "error", message: cause instanceof Error ? cause.message : String(cause) });
        } finally {
          try { controller.close(); } catch { /* canceled response */ }
        }
      }),
      cancel() { abort.abort(); },
    });
    return new Response(stream, { headers: sseHeaders({ "Cache-Control": "no-store" }) });
  }
  // Linux only: 把刚下载并解压的新版本(二进制 + 前端资源)原地替换到当前应用目录。
  // download 已把 tar.gz 解压到 <tmp>/rikkahub-updates/extracted-*/rikkahub-pc/,其中含新
  // 二进制和 web-ui。这里:
  //   1. 用 staging + rename 原子替换 web-ui 目录(routeStatic 每次请求重读,换完立即生效)
  //   2. rename 新二进制覆盖正在运行的二进制(Linux 允许,旧进程继续用旧 inode 直到退出)
  // 替换成功后前端提示用户重启;systemd 配 Restart=always 的会自动拉起新版本。
  //
  // Windows 走 Tauri NSIS 安装器,macOS 暂不支持原地更新 —— 都在此拒绝。Docker 也不行
  // (容器重建即丢失替换),应 docker pull。
  if (path === "update/apply" && request.method === "POST") {
    if (RUNTIME_PLATFORM !== "linux") return error("仅 Linux 支持原地更新", 400);
    if (RUNNING_IN_CONTAINER) return error("容器化部署无法原地更新，请通过 docker pull 升级镜像", 400);
    try {
      const body = await readJson<{ path?: string }>(request);
      const srcExe = String(body.path ?? "").trim();
      if (!srcExe) return error("缺少更新文件路径", 400);
      const resolvedSrcExe = resolve(srcExe);
      if (!existsSync(resolvedSrcExe)) return error("更新文件不存在", 404);
      if (statSync(resolvedSrcExe).size === 0) return error("更新文件为空", 400);

      // Security: srcExe 必须在我们的受信任更新目录树内(download 解压到这里),否则一个构造
      // 的请求可能让我们把任意文件拷到可执行路径上。
      const updatesDir = resolve(updatesCacheDir);
      const rel = relative(updatesDir, resolvedSrcExe);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        return error("更新文件路径不在受信任目录内", 400);
      }

      const currentExe = resolve(process.execPath);
      const currentAppDir = dirname(currentExe);
      if (!existsSync(currentExe)) return error(`当前可执行文件路径无效：${currentExe}`, 500);

      // 新应用目录 = 解压出的 rikkahub-pc/(新二进制的同级目录,含新 web-ui)。
      const newAppDir = dirname(resolvedSrcExe);

      // ── 1. 替换随包资源目录 (web-ui / icons / fonts) ────────────────────
      // 拷到 .<name>.new 再原子 rename 覆盖。cp 失败不致命(新版本可能没改该目录):记
      // warning 后继续 —— 避免资源替换的小问题阻塞整个更新;但 rename 交换半途失败意味着
      // 旧目录已被挪走、状态不确定,必须回滚。返回值区分这两种失败,由调用侧决定后果:
      // web-ui 交换失败要中止更新(二进制换了前端没换,重启后前后端版本错位);
      // icons/fonts 是 8-5 起随包分发的品牌图标/内置字体,失败只降级显示,不阻塞。
      const swapAppResourceDir = (name: string): "ok" | "copy_failed" | "swap_failed" => {
        const currentDir = join(currentAppDir, name);
        const newDir = join(newAppDir, name);
        if (!existsSync(newDir)) return "ok"; // 更新包不带该目录(老包):跳过
        const staging = join(currentAppDir, `.${name}.new`);
        const bak = join(currentAppDir, `.${name}.bak`);
        try {
          if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
          const cp = Bun.spawnSync(["cp", "-r", newDir, staging]);
          if (cp.exitCode !== 0) {
            console.warn(`[update/apply] cp ${name} to staging failed:`, cp.stderr?.toString().trim());
            return "copy_failed";
          }
          if (existsSync(currentDir)) {
            if (existsSync(bak)) rmSync(bak, { recursive: true, force: true });
            try { renameSync(currentDir, bak); } catch { /* 首次安装可能没有旧目录 */ }
            try {
              renameSync(staging, currentDir);
              try { rmSync(bak, { recursive: true, force: true }); } catch { /* */ }
            } catch (swapErr) {
              console.warn(`[update/apply] ${name} swap failed, rolling back:`, swapErr);
              try { if (existsSync(bak)) renameSync(bak, currentDir); } catch { /* */ }
              return "swap_failed";
            }
          } else {
            // 当前没有该目录(异常状态或老部署),直接把 staging 就位。
            renameSync(staging, currentDir);
          }
          return "ok";
        } catch (err) {
          console.warn(`[update/apply] ${name} update skipped:`, err);
          return "copy_failed";
        }
      };

      if (swapAppResourceDir("web-ui") === "swap_failed") {
        return error("替换前端资源失败，更新未完成", 500);
      }
      swapAppResourceDir("icons");
      swapAppResourceDir("fonts");

      // ── 2. 备份 + 原子替换二进制 ───────────────────────────────────────
      // 必须同时绕开两个 Linux 约束:
      //   (a) currentExe 正在运行:Linux 禁止 write/open 它(ETXTBSY),但同文件系统内的
      //       rename(2) 可以覆盖它——rename 只改目录项,旧 inode 留给运行中的进程直到退出,
      //       下次启动即用新版本。这是 Linux 自更新二进制的标准机制。
      //   (b) 下载的新二进制在 /tmp,常与安装目录(/home/...)不在同一文件系统,跨设备
      //       rename 直接 EXDEV。
      // 旧逻辑"rename(源→目标),失败 fallback copy"两头堵死:跨设备 rename→EXDEV,
      // fallback 直接 copy 目标→ETXTBSY(运行中)。正解:先 copy 到安装目录下的临时文件
      // (跨设备 copy 合法,目标是新文件不触发 ETXTBSY),再在同文件系统内 rename 覆盖当前
      // 二进制(同设备不 EXDEV,且能覆盖运行中的二进制)。与上面 web-ui 的 staging+rename
      // 同构。
      const backupPath = `${currentExe}.bak`;
      try {
        if (existsSync(backupPath)) unlinkSync(backupPath);
        copyFileSync(currentExe, backupPath);
      } catch (backupErr) {
        console.warn("[update/apply] binary backup skipped:", backupErr);
      }
      const stagingExe = `${currentExe}.new`;
      try {
        copyFileSync(resolvedSrcExe, stagingExe);
        try { chmodSync(stagingExe, 0o755); } catch { /* */ }
        renameSync(stagingExe, currentExe);
      } catch (swapErr) {
        try { if (existsSync(stagingExe)) unlinkSync(stagingExe); } catch { /* */ }
        console.warn("[update/apply] binary swap failed:", swapErr);
        return error(`替换二进制失败：${swapErr instanceof Error ? swapErr.message : String(swapErr)}`, 500);
      }

      return json({ status: "ok", exePath: currentExe, backupPath: existsSync(backupPath) ? backupPath : null, needRestart: true });
    } catch (err) {
      return error(`应用更新失败：${err instanceof Error ? err.message : String(err)}`, 500);
    }
  }
  if (path === "update/skip" && request.method === "POST") {
    const body = await readJson<{ version?: string }>(request);
    let version: string;
    try { version = normalizeReleaseVersion(String(body.version ?? "")); } catch { return error("Invalid release version", 400); }
    writeSkippedVersion(version);
    return json({ status: "ok", skipped: version });
  }
  return null;
}
