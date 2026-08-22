// workspace/tools/embedded-bash.ts — Windows 内嵌 bash 运行时的懒落地。
//
// 定位:bash 探测链的最后一道兜底(见 shell.ts getShellConfig 的优先级注释)——
// 用户 shellPath → 系统 Git Bash → 本模块的内嵌 bash。它让"什么都没装的小白"开箱即用,
// 不为已有环境的人换实现。
//
// 懒落地:bundle 经 `with { type: "file" }` 嵌进 exe,首次需要时经 Bun.Archive 解压到
// embeddedBashDir(pc-data/runtime-bin/bash/),之后 embeddedBashAvailableSync() 同步命中、
// 不再解压。版本戳(bash-bundle.version.json 进 git)比对不一致 → 整目录清掉重落地(升级覆盖)。
//
// 安全:与系统 bash 走完全相同的工作区边界/审批(runtime.ts),仅 spawn 的 exe 路径不同。
// 落地用 Bun.Archive(原生拒绝绝对路径/危险 symlink);固定路径 + 仅版本变更删写,杀软友好。

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import bashBundlePath from "../../assets/bash-bundle.tar.gz" with { type: "file" };
import { embeddedBashDir, embeddedBashExe, embeddedBashStampPath } from "../../foundation/paths";
import { reportError } from "../../observability/app-errors";
import { getBashShellConfig, shellRunsBash } from "./shell";

// 与 build-bash-bundle.ts 写出的 bash-bundle.version.json 同构;只取落地判定需要的字段。
interface BundleManifest {
  bundleVersion: string;
  sha256: string;
}

// 嵌入包清单作为常量内嵌(避免运行时读 gitignored 的版本 json 文件——它只供构建期与 git 追溯)。
// 与 assets/bash-bundle.version.json 同源;不一致时落地重建由 mtime 指纹驱动,见 stampMatches。
import bundleManifestJson from "../../assets/bash-bundle.version.json";
const bundleManifest = bundleManifestJson as BundleManifest;

/** 读落地目录的版本戳,与嵌入清单比对。不一致(升级/损坏/首次)→ false,触发重落地。 */
function stampMatches(): boolean {
  try {
    const stamp = JSON.parse(readFileSync(embeddedBashStampPath, "utf-8")) as { bundleVersion?: string };
    return stamp.bundleVersion === bundleManifest.bundleVersion;
  } catch {
    // 戳文件不存在/损坏 → 视为不匹配,走重落地(幂等,非错误)。
    return false;
  }
}

/**
 * 同步快路径:已落地且版本戳匹配 → 直接返回 bash.exe 路径,否则 null。
 * 供同步的 getShellConfig 在 Windows 候选全失败后调用(不能 await,故只看"已落地"情形)。
 * 附 existsSync + 非空文件校验,挡住"戳在但 exe 被杀软删了"的半落地态。
 */
export function embeddedBashAvailableSync(): string | null {
  if (process.platform !== "win32") return null;
  if (!existsSync(embeddedBashExe) || statSync(embeddedBashExe).size === 0) return null;
  return stampMatches() ? embeddedBashExe : null;
}

// 进程内单 Promise 锁(同 mupdf 加载模式):并发首次落地只跑一遍;失败不缓存,下次可重试。
let landingPromise: Promise<string> | null = null;

/**
 * 懒落地主函数(异步)。返回可用的 bash.exe 路径。
 * 落地失败 reject(已 reportError),并把锁置空以便下次重试;调用方据此降级回系统探测。
 */
export function ensureEmbeddedBash(): Promise<string> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("embedded bash is Windows-only"));
  }
  const cached = embeddedBashAvailableSync();
  if (cached) return Promise.resolve(cached);

  landingPromise ??= (async () => {
    try {
      // 版本戳不匹配(升级) → 整目录清掉重落地(仅此时删写,满足"不频繁删写")。
      if (existsSync(embeddedBashDir) && !stampMatches()) {
        rmSync(embeddedBashDir, { recursive: true, force: true });
      }
      mkdirSync(embeddedBashDir, { recursive: true });

      // 读嵌入字节 → Bun.Archive 解压(原生拒绝绝对路径/危险 symlink;保留 +x 位)。
      // bundle 内含 etc/fstab(usertemp 行)把 /tmp 挂到当前用户 Temp,消除 MSYS2 启动自检的
      // "could not find /tmp" 告警,并让 mktemp / tar 落临时文件可用(行为对齐系统 Git)。
      const bytes = await Bun.file(bashBundlePath).bytes();
      await new Bun.Archive(bytes).extract(embeddedBashDir);

      // 运行验证:解出来的 bash 必须真能跑一条 echo,否则视为落地失败(拦截杀软误删/损坏)。
      if (!existsSync(embeddedBashExe) || !shellRunsBash(getBashShellConfig(embeddedBashExe))) {
        throw new Error("embedded bash extracted but failed echo verification");
      }

      // 验证通过才写版本戳(戳 = "这一版落地可用"的承诺;先写戳后验证会留下假成功态)。
      writeFileSync(embeddedBashStampPath, JSON.stringify({ bundleVersion: bundleManifest.bundleVersion, landedAt: Date.now() }));
      return embeddedBashExe;
    } catch (err) {
      landingPromise = null; // 失败不缓存 Promise,下次调用重试
      reportError("workspace", "warn", "内嵌 bash 落地失败,退回系统探测", err, "embedded_bash_land_failed");
      throw err;
    }
  })();
  return landingPromise;
}

/** 测试钩子:重置落地锁(不删已落地文件)。 */
export function _resetEmbeddedBashForTest(): void {
  landingPromise = null;
}
