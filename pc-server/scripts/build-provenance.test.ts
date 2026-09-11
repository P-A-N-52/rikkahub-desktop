import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventory, sha256 } from "./build-provenance";
import { restoreCatalog, validateCatalogRecords } from "./model-catalog";
import { assertMinimumSystemVersion, macSigning, writeChecksums } from "./package-macos";
import { parseReleaseRepository } from "../shared/release-source";
import { parseDesktopBuildArgs } from "./build-desktop";

function temporary<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rikkahub-provenance-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("macOS build provenance and signing boundaries", () => {
  test("release source is explicit and rejects URLs, refs and malformed paths", () => {
    expect(parseReleaseRepository("example/RikkaHub-desktop")).toBe("example/RikkaHub-desktop");
    for (const invalid of ["https://github.com/a/b", "a/b/c", "a/b.git", "../b", "a/b#main", " a/b", "a/$(whoami)", "a\\b"]) {
      expect(() => parseReleaseRepository(invalid)).toThrow("owner/repository");
    }
    expect(parseDesktopBuildArgs(["--target", "aarch64-apple-darwin", "--release-repository", "example/client"])?.releaseRepository).toBe("example/client");
  });

  test("unsigned, hardened ad-hoc and Developer ID modes cannot be confused", () => {
    expect(macSigning(false)).toEqual({ mode: "adhoc" });
    expect(macSigning(true)).toEqual({ mode: "none" });
    expect(macSigning(false, "Developer ID Application: Example (TEAM123456)", "release-profile").mode).toBe("developer-id");
    expect(() => macSigning(true, "Developer ID Application: Example")).toThrow("cannot be combined");
    expect(() => macSigning(false, "-")).toThrow("Developer ID");
    expect(() => macSigning(false, undefined, "release-profile")).toThrow("requires");
    expect(() => parseDesktopBuildArgs(["--target", "aarch64-apple-darwin", "--sidecar-only", "--signing-identity", "Developer ID Application: Example"])).toThrow("complete macOS app");
  });

  test("neither missing nor newer executable deployment targets can pass the declared minimum", () => {
    expect(() => assertMinimumSystemVersion("13.0", [{ name: "shell", minimumSystemVersion: "11.0" }, { name: "sidecar", minimumSystemVersion: "13.0" }])).not.toThrow();
    expect(() => assertMinimumSystemVersion("13.0", [{ name: "sidecar", minimumSystemVersion: "13.1" }])).toThrow("above declared");
    expect(() => assertMinimumSystemVersion("13.0", [{ name: "sidecar", minimumSystemVersion: null }])).toThrow("unknown");
    expect(() => assertMinimumSystemVersion("invalid", [])).toThrow("Invalid minimum");
  });

  test("resource inventory records executable bits and detects content changes without following outside links", () => temporary((dir) => {
    mkdirSync(join(dir, "Resources"));
    writeFileSync(join(dir, "Resources/index.html"), "first");
    writeFileSync(join(dir, "helper"), "binary", { mode: 0o755 });
    symlinkSync("Resources/index.html", join(dir, "inside"));
    const first = inventory(dir);
    expect(first.find((file) => file.path === "helper")?.executable).toBe(true);
    expect(first.find((file) => file.path === "inside")?.link).toBe("Resources/index.html");
    writeFileSync(join(dir, "Resources/index.html"), "second");
    expect(inventory(dir)).not.toEqual(first);
    symlinkSync("/etc/passwd", join(dir, "outside"));
    expect(() => inventory(dir)).toThrow("Escaping bundle link");
  }));

  test("checksum file binds the manifest and every distributable", () => temporary((dir) => {
    const artifacts = [{ name: "Rikkahub.app.zip", sha256: sha256("archive") }, { name: "Rikkahub.dmg", sha256: sha256("image") }];
    writeChecksums(dir, "build.manifest.json", { artifacts, target: "aarch64-apple-darwin" });
    const manifest = readFileSync(join(dir, "build.manifest.json"));
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toContain(`${sha256(manifest)}  build.manifest.json`);
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n")).toHaveLength(3);
  }));

  test("model restore only accepts complete generated-catalog paths", () => {
    const records = [{ path: "models.generated.ts", sha256: sha256("models") }, { path: "providers/data/.manifest.json", sha256: sha256("manifest") }];
    expect(() => validateCatalogRecords(records)).not.toThrow();
    for (const path of ["../server.ts", "providers/openai.ts", "providers/data/../../index.ts", "/models.generated.ts"]) {
      expect(() => validateCatalogRecords([...records, { path, sha256: sha256("unexpected") }])).toThrow("Invalid model snapshot");
    }
    expect(() => validateCatalogRecords([...records, records[0]!])).toThrow("Invalid model snapshot");
    expect(() => validateCatalogRecords(records.slice(0, 1))).toThrow("incomplete");
  });
});

test("public model source recorder captures exact bytes and refuses credentials or unrelated hosts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rikkahub-model-recorder-"));
  try {
    const script = join(dir, "fixture.ts");
    const recorder = join(import.meta.dir, "model-fetch-recorder.ts");
    writeFileSync(script, `
      let fetches = 0;
      globalThis.fetch = async () => { fetches++; return new Response('{"models":["public-fixture"]}', {status:200}); };
      await import(${JSON.stringify(recorder)});
      const payload = await (await fetch("https://models.dev/api.json")).json();
      let rejected = 0;
      for (const [url, options] of [["https://example.com/private", {}], ["https://models.dev/api.json", {headers:{Authorization:"fixture"}}]]) {
        try { await fetch(url, options); } catch { rejected++; }
      }
      console.log(JSON.stringify({fetches,rejected,payload}));
    `);
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, RIKKAHUB_MODEL_SOURCE_DIR: join(dir, "sources") }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ fetches: 1, rejected: 2, payload: { models: ["public-fixture"] } });
    const sources = JSON.parse(readFileSync(join(dir, "sources/sources.json"), "utf8"));
    expect(sources).toHaveLength(1);
    const source = sources[0];
    expect(source.url).toBe("https://models.dev/api.json");
    expect(sha256(readFileSync(join(dir, "sources", source.file)))).toBe(source.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const failure of ["copy", "rename", "none"] as const) {
  test(`model restore ${failure === "none" ? "atomically replaces the catalog" : `preserves original bytes on ${failure} failure`}`, () => temporary((dir) => {
    const root = join(dir, "src");
    const snapshot = join(dir, "snapshot");
    mkdirSync(join(root, "providers/data"), { recursive: true });
    mkdirSync(join(snapshot, "providers/data"), { recursive: true });
    writeFileSync(join(root, "models.generated.ts"), "old aggregator");
    writeFileSync(join(root, "providers/old.models.ts"), "old shard");
    writeFileSync(join(root, "providers/data/.manifest.json"), "old manifest");
    writeFileSync(join(root, "providers/runtime.ts"), "runtime source must survive");
    const data = { "models.generated.ts": "new aggregator", "providers/new.models.ts": "new shard", "providers/data/.manifest.json": "new manifest" };
    const files = Object.entries(data).map(([path, content]) => {
      writeFileSync(join(snapshot, path), content);
      return { path, sha256: sha256(content) };
    });
    const before = inventory(root);
    let copies = 0, renames = 0;
    const run = () => restoreCatalog(root, snapshot, files, {
      copy: (source, target) => { if (++copies === 2 && failure === "copy") throw new Error("injected ENOSPC"); copyFileSync(source, target); },
      rename: (source, target) => { if (++renames === 4 && failure === "rename") throw new Error("injected EACCES"); renameSync(source, target); },
    });
    if (failure === "none") {
      run();
      expect(readFileSync(join(root, "models.generated.ts"), "utf8")).toBe("new aggregator");
      expect(readFileSync(join(root, "providers/runtime.ts"), "utf8")).toBe("runtime source must survive");
      expect(inventory(root).some((file) => file.path === "providers/old.models.ts")).toBe(false);
    } else {
      expect(run).toThrow("injected");
      expect(inventory(root)).toEqual(before);
    }
  }));
}
