// bun test 预载(经根目录 bunfig.toml 挂载):在任何被测模块加载前,把数据目录
// 钉到一次性临时目录。paths.ts 在首次 import 时固化 dataDir——没有这层预载时,
// 首个未自设 RIKKAHUB_PC_DATA_DIR 的测试文件会把整个测试进程的读写钉到开发者
// 真实的 pc-data(M4-0 曾因此把数百条测试工作区/会话写进真实库,并产生跨轮次的
// 假失败)。单跑某个自设临时目录的测试文件时,该文件的赋值仍然生效(它在 paths
// 首次 import 前覆盖环境变量),隔离语义不变。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.RIKKAHUB_PC_DATA_DIR) {
  process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-test-data-"));
}

// 跨测试隔离:把「上次工作区档位记忆」在每个用例前归零。
//
// updateWorkspace 会把用户显式改的档位回写进进程级全局
// state.settings.workspaceLastPermissionPreset(workspace/index.ts:213,线上特性"记住上次
// 选择"),而 createWorkspace 又读它作为新建默认档位(:181)。测试共享这一个 state 对象,任一
// 文件改了档位、恢复时机稍差,就把 full_access/confirm_each 泄漏给随后期望 balanced 的断言
// (M1 起多个测试文件都踩过;1.4.0 改了调度时序后稳定显形)。
//
// 逐文件各自 setState 沙箱 + finally 恢复既重复又易漏。这里在源头收口:bun 会把 preload 注册的
// beforeEach 挂到所有测试文件的每个用例上(已实证),无论哪个文件在哪改了这个全局键,下一个
// 用例开始前都归零,createWorkspace 读到的恒为"无记忆"(null → normalizePreset 回退 balanced)。
//
// 不在此处顶层 import json-store:那会经 persistence→foundation/paths 在 preload 阶段就固化
// dataDir,剥夺各测试文件自设 RIKKAHUB_PC_DATA_DIR 的隔离能力(上面的数据目录沙箱同理,只能
// 设环境变量、不能 import paths)。改为在 beforeEach 回调里惰性 await import——彼时首个测试文件
// 已固化好自己的数据目录,且 state 是 live binding,拿到的是当前真实对象。
//
// 不破坏 workspace.test.ts 的「档位记忆」测试:beforeEach 只在每个 test() 之间触发,该测试在
// 单个 test 体内完成 读→改→读 全程,不受间隙重置影响。生产代码零改动、无环境分支。
import { beforeEach } from "bun:test";

beforeEach(async () => {
  const { state } = await import("./persistence/json-store");
  if (state?.settings) state.settings.workspaceLastPermissionPreset = null;
});
