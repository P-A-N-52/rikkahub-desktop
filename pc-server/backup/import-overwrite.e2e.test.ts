// 全面审查 5-1(P0)+5-6 端到端回归:恢复备份绝不覆写本机现有附件字节,且导入前留有
// state.json 快照。原缺陷:恢复把 nextFileId 重置为 1 / 老 JSON 路径按备份内原 id 写
// filesDir/<id>.<ext>,与本机现有附件同名 → 旧字节被直接覆写,不可逆。
import { waitForServerReady } from "../test-utils/e2e-server";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverEntry = join(import.meta.dir, "..", "server.ts");

describe("备份恢复不覆写现有附件(5-1)+ 导入前 state.json 快照(5-6)", () => {
  test("上传附件后导入含同 id 文件的老 JSON 备份:旧字节原封不动,备份内容走新路径,快照落盘", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-import-e2e-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18250", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir, RIKKAHUB_ANALYTICS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      const base = `http://127.0.0.1:${port}`;

      // 1) 上传本机附件 → 全新安装分配 id=1,落盘 files/1.png
      const uploadForm = new FormData();
      uploadForm.append("files", new File([new TextEncoder().encode("OLD-LOCAL-BYTES")], "photo.png", { type: "image/png" }));
      const uploadRes = await fetch(`${base}/api/files/upload`, { method: "POST", body: uploadForm });
      expect(uploadRes.status).toBe(200);
      const uploaded = (await uploadRes.json()) as { files: Array<{ id: number }> };
      expect(uploaded.files[0]!.id).toBe(1);
      const localFilePath = join(dataDir, "files", "1.png");
      expect(readFileSync(localFilePath, "utf8")).toBe("OLD-LOCAL-BYTES");

      // 2) 导入"另一台机器"的老 JSON 备份,里面也有 id=1 的文件(不同内容)
      const backup = {
        state: {
          settings: { assistantId: "a-import" },
          files: [{ id: 1, path: "C:/elsewhere/1.png", fileName: "other.png", mime: "image/png", size: 15 }],
          nextFileId: 2,
        },
        files: [{ id: 1, originalName: "other.png", data: Buffer.from("NEW-BACKUP-BYTES").toString("base64") }],
      };
      const importForm = new FormData();
      importForm.append("file", new File([JSON.stringify(backup)], "backup.json", { type: "application/json" }));
      const importRes = await fetch(`${base}/api/data/import`, { method: "POST", body: importForm });
      expect(importRes.status).toBe(200);

      // 3) 原缺陷断言点:本机 files/1.png 的旧字节必须原封不动(旧实现在此被覆写成备份内容)
      expect(readFileSync(localFilePath, "utf8")).toBe("OLD-LOCAL-BYTES");

      // 4) 备份文件内容经新路径提供:/api/files/1/content 现在按导入后的账本指向恢复批次文件
      const contentRes = await fetch(`${base}/api/files/1/content`);
      expect(contentRes.status).toBe(200);
      expect(await contentRes.text()).toBe("NEW-BACKUP-BYTES");

      // 5) 5-6:导入前 state.json 快照存在,且里面还是导入前的设置
      const bakPath = join(dataDir, "state.json.pre-import.bak");
      expect(existsSync(bakPath)).toBe(true);
      const bak = JSON.parse(readFileSync(bakPath, "utf8")) as { settings?: { assistantId?: string } };
      expect(bak.settings?.assistantId).not.toBe("a-import");
    } finally {
      proc.kill();
    }
  }, 40_000);
});
