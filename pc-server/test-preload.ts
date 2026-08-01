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
