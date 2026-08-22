// workspace/tools/fs-walk.test.ts — walkDirectory 跳过语义回归(E2-①)
// 锁定"产物目录跳过 + .gitignore 可取回 + 安全边界恒跳"三条不变式,
// 为将来调整 SKIPPED_ARTIFACT_DIRS(含回退 A)提供测试护栏。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkDirectory } from "./fs-walk";

/** 造一棵目录树并返回收集到的相对路径(files only)。 */
function collect(files: Record<string, string>, gitignore?: string): string[] {
  const root = mkdtempSync(join(tmpdir(), "rkh-fswalk-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  if (gitignore !== undefined) writeFileSync(join(root, ".gitignore"), gitignore);

  const visited: string[] = [];
  walkDirectory(root, {
    onEntry: (entry) => {
      // .gitignore 是 fixture 元数据,不参与跳过语义的断言
      if (!entry.isDirectory && entry.relativePath !== ".gitignore") visited.push(entry.relativePath);
    },
  });
  return visited.sort();
}

describe("walkDirectory 跳过语义", () => {
  test(".git 与 node_modules 恒跳(安全边界,不可被 .gitignore 取回)", () => {
    const visited = collect(
      {
        ".git/config": "x",
        "node_modules/pkg/index.js": "x",
        "src/index.ts": "x",
      },
      // 即便 .gitignore 显式取反也不应救回安全边界目录
      "!node_modules/\n",
    );
    expect(visited).toEqual(["src/index.ts"]);
  });

  test("公认产物目录默认跳过", () => {
    const visited = collect({
      "target/debug/app.bin": "x",
      "dist/bundle.js": "x",
      "build/out.o": "x",
      ".next/static/chunk.js": "x",
      "__pycache__/mod.pyc": "x",
      "coverage/lcov.info": "x",
      "src/main.ts": "x",
    });
    expect(visited).toEqual(["src/main.ts"]);
  });

  test("产物目录可被 .gitignore 的 !name/ 取回", () => {
    const visited = collect(
      {
        "build/keep.ts": "x",
        "dist/bundle.js": "x",
      },
      // 取回 build/(dist 仍按产物跳过)
      "!build/\n",
    );
    expect(visited).toEqual(["build/keep.ts"]);
  });

  test("普通源码目录不误伤", () => {
    const visited = collect({
      "src/components/Button.tsx": "x",
      "docs/guide.md": "x",
      "scripts/release.sh": "x",
    });
    expect(visited).toEqual(["docs/guide.md", "scripts/release.sh", "src/components/Button.tsx"]);
  });
});
