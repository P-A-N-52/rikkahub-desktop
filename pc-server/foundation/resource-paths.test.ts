import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveResourcePaths } from "./paths";

const host = mkdtempSync(join(tmpdir(), "rkh-resource-paths-"));
const source = join(host, "source");
const executable = join(host, "executable");
mkdirSync(source);
mkdirSync(executable);
afterAll(() => rmSync(host, { recursive: true, force: true }));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function bundle(name: string): string {
  const root = join(host, name, "Example 应用.app", "Contents", "Resources");
  write(join(root, "web-ui", "build", "client", "index.html"), "<!doctype html><title>fixture app</title>");
  write(join(root, "web-ui", "build", "client", "assets", "entry-fixture.js"), "export const fixture = true;");
  write(join(root, "fonts", "manifest.json"), JSON.stringify({
    fixture: { label: "Fixture Font", family: "Fixture", weights: [{ file: "Fixture.ttf", weight: 400 }] },
  }));
  write(join(root, "fonts", "Fixture.ttf"), "fixture font bytes");
  write(join(root, "icons", "openai.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><title>fixture icon</title></svg>');
  return root;
}

/** 在独立进程内导入真实消费者，避免 paths.ts 的环境快照污染其他测试。 */
function runWithResources(root: string, body: string): void {
  const code = `
    import assert from "node:assert/strict";
    import { rmSync } from "node:fs";
    import { join } from "node:path";
    const paths = await import(${JSON.stringify(join(import.meta.dir, "paths.ts"))});
    const { routeStatic } = await import(${JSON.stringify(join(import.meta.dir, "../api/static.ts"))});
    const { listBuiltinFonts, resolveFontFile } = await import(${JSON.stringify(join(import.meta.dir, "../assets/fonts.ts"))});
    const { serveAIIcon } = await import(${JSON.stringify(join(import.meta.dir, "../assets/icons.ts"))});
    ${body}
  `;
  execFileSync(process.execPath, ["--eval", code], {
    cwd: host,
    env: { ...process.env, RIKKAHUB_RESOURCE_DIR: root, RIKKAHUB_PC_DATA_DIR: join(host, "test-data"), RIKKAHUB_ANALYTICS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}

describe("resource directory contract", () => {
  test("显式绝对资源根使用固定布局，保留路径中的中文和空格", () => {
    const root = bundle("valid");
    const paths = resolveResourcePaths(source, executable, root);
    expect(paths.explicit).toBe(true);
    expect(paths.staticRoots).toEqual([join(root, "web-ui", "build", "client")]);
    expect(paths.fonts).toEqual([join(root, "fonts")]);
    expect(paths.icons).toEqual([join(root, "icons")]);
  });

  test("空值、相对路径和缺失资源根明确报错，不回退已存在的源码资源", () => {
    write(join(source, "web-ui", "build", "client", "index.html"), "source should not mask errors");
    for (const value of ["", "relative/resources"]) {
      expect(() => resolveResourcePaths(source, executable, value)).toThrow("absolute path");
    }
    expect(() => resolveResourcePaths(source, executable, join(host, "missing"))).toThrow("RIKKAHUB_RESOURCE_DIR");
  });

  test("资源根是文件、首页缺失、字体或图标目录缺失均拒绝", () => {
    const file = join(host, "not-a-directory");
    write(file, "file");
    expect(() => resolveResourcePaths(source, executable, file)).toThrow("directory");
    for (const relative of ["web-ui/build/client/index.html", "fonts", "icons"]) {
      const root = bundle(`missing-${relative.replaceAll("/", "-")}`);
      rmSync(join(root, relative), { recursive: true });
      expect(() => resolveResourcePaths(source, executable, root)).toThrow(relative.split("/").at(-1)!);
    }
  });

  test("未指定时保留源码与独立可执行文件的既有入口及顺序", () => {
    const dev = resolveResourcePaths(source, executable);
    expect(dev.explicit).toBe(false);
    expect(dev.staticRoots).toEqual([
      join(executable, "web-ui", "build", "client"), join(executable, "web-ui", "build"),
      join(source, "web-ui", "build", "client"), join(source, "web-ui", "build"), join(source, "web-ui", "dist"),
    ]);
    expect(dev.fonts).toEqual([join(executable, "fonts"), join(source, "fonts")]);
    expect(dev.icons).toEqual([join(executable, "icons"), join(source, "icons")]);
    const standalone = join(host, "standalone");
    mkdirSync(join(standalone, "web-ui"), { recursive: true });
    expect(resolveResourcePaths(source, standalone)).toEqual({
      explicit: false,
      staticRoots: [join(standalone, "web-ui", "build", "client"), join(standalone, "web-ui", "build"), join(standalone, "web-ui", "dist")],
      fonts: [join(standalone, "fonts")], icons: [join(standalone, "icons")],
    });
  });

  test("真实静态/字体/图标消费者从包资源读取，数据目录保持独立", () => {
    const root = bundle("consumers");
    runWithResources(root, `
      assert.equal(paths.dataDir, process.env.RIKKAHUB_PC_DATA_DIR);
      assert.equal(paths.customFontsDir, join(paths.dataDir, "fonts"));
      const home = await routeStatic(new URL("http://localhost/"));
      assert.equal(home.status, 200);
      assert.match(await home.text(), /fixture app/);
      assert.match(home.headers.get("Content-Security-Policy"), /object-src 'none'/);
      const route = await routeStatic(new URL("http://localhost/settings/general"));
      assert.match(await route.text(), /fixture app/);
      assert.equal(route.headers.get("Cache-Control"), "no-store");
      const script = await routeStatic(new URL("http://localhost/assets/entry-fixture.js"));
      assert.match(await script.text(), /fixture = true/);
      assert.equal(script.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
      assert.deepEqual(listBuiltinFonts().map((entry) => entry.label), ["Fixture Font"]);
      assert.equal(resolveFontFile("builtin", "Fixture.ttf"), join(process.env.RIKKAHUB_RESOURCE_DIR, "fonts", "Fixture.ttf"));
      assert.equal(resolveFontFile("builtin", "missing.ttf"), null);
      assert.equal(resolveFontFile("custom", "missing.ttf"), null);
      assert.match(await (await serveAIIcon("OpenAI")).text(), /fixture icon/);
      assert.match(await (await serveAIIcon("Unlisted fixture brand")).text(), /<svg/);
    `);
  });

  test("显式包缺少静态文件、已知图标或 manifest 声明字体时不借用源码", () => {
    const root = bundle("missing-files");
    runWithResources(root, `
      const missing = await routeStatic(new URL("http://localhost/assets/missing.js"));
      assert.equal(missing.status, 404);
      assert.match(await missing.text(), /Bundled resource not found/);
      await assert.rejects(serveAIIcon("Kimi"), /kimi-color.svg/);
      rmSync(join(process.env.RIKKAHUB_RESOURCE_DIR, "fonts", "Fixture.ttf"));
      assert.throws(() => listBuiltinFonts(), /Fixture.ttf/);
      rmSync(join(process.env.RIKKAHUB_RESOURCE_DIR, "web-ui", "build", "client", "index.html"));
      await assert.rejects(routeStatic(new URL("http://localhost/")), /index.html/);
    `);
  });

  test("缺失或损坏的随包字体 manifest 明确报错", () => {
    const missing = bundle("missing-manifest");
    rmSync(join(missing, "fonts", "manifest.json"));
    runWithResources(missing, `assert.throws(() => listBuiltinFonts(), /manifest.json/);`);
    const corrupt = bundle("corrupt-manifest");
    write(join(corrupt, "fonts", "manifest.json"), "{invalid");
    runWithResources(corrupt, `assert.throws(() => listBuiltinFonts(), /Invalid bundled font manifest/);`);
  });

  test("manifest 声明的单文件字体缺失同样报告打包错误", () => {
    const root = bundle("missing-single-font");
    write(join(root, "fonts", "manifest.json"), JSON.stringify({ "Declared.ttf": { label: "Declared font" } }));
    runWithResources(root, `assert.throws(() => listBuiltinFonts(), /Declared.ttf/);`);
  });
});
