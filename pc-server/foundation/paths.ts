// foundation/paths.ts — 路径常量
// 纪律：只导出路径字符串，不依赖业务逻辑，不引入副作用。

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

// 仓库根（web-ui/、fonts/、icons/、pc-data/ 的父目录）。本文件位于 pc-server/foundation/，
// 所以是上两级。注意 import.meta.dir 是位置敏感的：这段代码原在 pc-server/server.ts 时
// 只需 ".."，搬进本文件时漏改导致源码运行下 rootDir 指向 pc-server/——静态 UI/内置字体/
// 图标/开发数据目录全部失联（打包 exe 走 executableDir 分支不受影响）。若再移动本文件必须同步调整。
export const sourceRootDir = resolve(import.meta.dir, "..", "..");
export const executableDir = dirname(process.execPath);
export const rootDir = existsSync(join(executableDir, "web-ui")) ? executableDir : sourceRootDir;
export const dataDir = resolve(process.env.RIKKAHUB_PC_DATA_DIR ?? join(rootDir, "pc-data"));

export const filesDir = join(dataDir, "files");
export const skillsDir = join(dataDir, "skills");
// 工作区宿主目录(agent 模式)。managed 型工作区在 workspaces/<id>/{files/, tmp/} 下托管:
// files/ 是模型可见的边界根,tmp/ 放超长 shell 输出落盘等 PC 侧杂物;folder 型工作区
// root 指向用户真实目录,但 tmp/ 仍在这里(不污染用户目录)。
export const workspacesDir = join(dataDir, "workspaces");
// 用户上传的自定义字体。跟 files/skills 同级，落在 pc-data/ 下，gitignored 且应用更新不覆盖。
export const customFontsDir = join(dataDir, "fonts");
// pi 引擎的 agentDir（方案"客房"：近乎空置、可整目录清空、用户无感）。auth.json/models.json
// 永不写入——模型与密钥经 ModelRuntime 内存注册注入，唯一事实源是 state.json。
export const piAgentDir = join(dataDir, "pi-agent");
export const statePath = join(dataDir, "state.json");
// 会话活库（SQLite，WAL）。1.2.6：会话从 state.json 迁出，改用 SQLite 增量写——流式只
// upsert 当前在长的那个节点行，不再每 200ms 全量重写 state.json。与备份库（导出时现场
// 生成、Android 兼容）是不同文件/表名/schema：活库 pc_conversation/pc_message_node 为 PC
// 超集（含 system_prompt，Android 备份库没有这列）。
// 详见 conversation-persistence-design.md。
export const conversationsDbPath = join(dataDir, "rikka_hub.db");
export const skipVersionPath = join(dataDir, "skip-version.txt");
// 已下载更新包的缓存目录。放在持久的 dataDir 下（而非系统 tempDir）——系统临时目录会被
// OS/磁盘清理/重启清掉，会导致"下次进更新界面又得重下"。Windows 存 .exe 安装器，Linux
// 存 tar.gz 及其解压产物。probeCachedInstaller / update/download / update/apply 共用。
export const updatesCacheDir = join(dataDir, "updates");

export const memoryDir = join(dataDir, "memory");
export const globalMemoryPath = join(memoryDir, "global_memory.json");
export const assistantMemoryPath = join(memoryDir, "assistant_memory.json");
export const pendingMemoryPath = join(memoryDir, "pending_memory.json");

export const deviceIdPath = join(dataDir, "device-id.txt");

export const MODELS_DEV_CACHE_PATH = join(dataDir, "models-dev-cache.json");
