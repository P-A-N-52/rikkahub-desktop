// scripts/bump-version.ts — 版本号单一修改入口（N-6）
// 用法：bun run version:bump 2.0.0-preview（在 pc-server/ 下）
//
// 版本号需要出现在四处（各有硬性理由，无法在构建/运行时互相派生）：
//   - pc-server/updates/index.ts APP_VERSION：更新检查接口，编译进单 exe；
//     Docker 构建只 COPY pc-server/，无法跨包 import web-ui 侧文件。
//   - web-ui/src-tauri/tauri.conf.json：Tauri 安装包版本。
//   - web-ui/src-tauri/Cargo.toml：Rust crate 版本（Tauri 构建元数据）。
//   - web-ui/app/components/settings/about.tsx：关于页展示的前端版本号。
// 本脚本把"四处人工同步"收敛为"一条命令"；漏跑脚本手改单处时，
// CI 的 check-version-sync.ts 会红灯拦截。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const newVersion = process.argv[2];
// 接受 x.y.z 与带 prerelease 后缀的 x.y.z-preview/.beta.N 等(semver);Tauri nsis 文件名、
// Cargo semver、check-version-sync 均兼容该形态。
if (!newVersion || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(newVersion)) {
  console.error("用法: bun run version:bump <x.y.z[-prerelease]>（例如 2.0.0-preview）");
  process.exit(1);
}

const root = join(import.meta.dir, "..", "..");

const targets: Array<{ file: string; pattern: RegExp; replacement: string }> = [
  {
    file: join(root, "pc-server", "updates", "index.ts"),
    pattern: /export const APP_VERSION = "[^"]+";/,
    replacement: `export const APP_VERSION = "${newVersion}";`,
  },
  {
    file: join(root, "web-ui", "src-tauri", "tauri.conf.json"),
    pattern: /"version": "[^"]+",/,
    replacement: `"version": "${newVersion}",`,
  },
  {
    file: join(root, "web-ui", "src-tauri", "Cargo.toml"),
    pattern: /^version = "[^"]+"$/m,
    replacement: `version = "${newVersion}"`,
  },
  {
    // 关于页展示的前端版本号。SPA 与 pc-server 分属两个包,构建期无法互相 import,
    // 运行时从 /api/health 取又引入异步闪烁,故同样收敛到本脚本统一改写。
    file: join(root, "web-ui", "app", "components", "settings", "about.tsx"),
    pattern: /const APP_VERSION = "[^"]+";/,
    replacement: `const APP_VERSION = "${newVersion}";`,
  },
];

for (const target of targets) {
  const content = readFileSync(target.file, "utf8");
  if (!target.pattern.test(content)) {
    console.error(`未找到版本号声明: ${target.file}（模式 ${target.pattern}）`);
    process.exit(1);
  }
  const next = content.replace(target.pattern, target.replacement);
  writeFileSync(target.file, next);
  console.log(`已更新: ${target.file}`);
}

// 写完立即用同一套 CI 检查逻辑复验，确保三处真的一致
const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "check-version-sync.ts")], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(proc.exitCode ?? 1);
