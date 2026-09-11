import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const PI_COMMIT = "5cd93f688aaab89dbb6dfa4aca535f21796ae185";
export const BUN_VERSION = "1.4.0";
export type FileRecord = { path: string; bytes?: number; sha256?: string; link?: string; executable?: boolean };

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable inventory; reject links escaping the packaged directory rather than hashing their targets. */
export function inventory(directory: string): FileRecord[] {
  const root = resolve(directory);
  const records: FileRecord[] = [];
  const visit = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      const info = lstatSync(path);
      const entry = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) {
        const link = readlinkSync(path);
        const target = resolve(folder, link);
        if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`Escaping bundle link: ${entry}`);
        records.push({ path: entry, link });
      } else if (info.isDirectory()) visit(path);
      else if (info.isFile()) records.push({ path: entry, bytes: info.size, sha256: sha256(readFileSync(path)), executable: Boolean(info.mode & 0o111) });
      else throw new Error(`Unsupported bundle entry: ${entry}`);
    }
  };
  visit(root);
  return records;
}

export function commandOutput(command: string[], cwd: string, env?: Record<string, string | undefined>): string {
  const child = Bun.spawnSync(command, { cwd, ...(env ? { env } : {}), stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`${command[0]} failed: ${child.stderr.toString().trim()}`);
  return child.stdout.toString().trim();
}

export function modelCatalogFiles(repositoryDir: string): FileRecord[] {
  const root = join(repositoryDir, "pi/packages/ai/src");
  if (!existsSync(join(root, "providers/data/.manifest.json"))) throw new Error("Pi generated model catalog is missing");
  const files = ["models.generated.ts", ...readdirSync(join(root, "providers"))
    .filter((file) => file.endsWith(".models.ts")).map((file) => `providers/${file}`),
  ...inventory(join(root, "providers/data")).map((file) => `providers/data/${file.path}`)].sort();
  return files.map((path) => {
    const content = readFileSync(join(root, path));
    return { path, bytes: content.byteLength, sha256: sha256(content) };
  });
}

function piSourceState(repositoryDir: string, catalog: FileRecord[]) {
  const piDir = join(repositoryDir, "pi");
  const generated = new Set(catalog.map((file) => `packages/ai/src/${file.path}`));
  const files = commandOutput(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], piDir).split("\0").filter(Boolean).sort();
  const sourceFiles = files.filter((path) => !generated.has(path)).map((path) => ({ path,
    sha256: existsSync(join(piDir, path)) ? sha256(readFileSync(join(piDir, path))) : null }));
  const temporary = mkdtempSync(join(tmpdir(), "rikkahub-pi-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
    commandOutput(["git", "read-tree", "HEAD"], piDir, env);
    const patches = readdirSync(join(repositoryDir, "pi-patches")).filter((name) => name.endsWith(".patch")).sort();
    if (patches.length) commandOutput(["git", "apply", "--cached", ...patches.map((name) => join(repositoryDir, "pi-patches", name))], piDir, env);
    const modified = commandOutput(["git", "diff", "--name-only", "-z"], piDir, env).split("\0").filter(Boolean);
    const untracked = commandOutput(["git", "ls-files", "--others", "--exclude-standard", "-z"], piDir, env).split("\0").filter(Boolean);
    const unexpectedChanges = [...new Set([...modified, ...untracked])]
      .filter((path) => path !== "bun.lock" && !generated.has(path)).sort();
    return { sourceFiles, unexpectedChanges };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function buildInputs(repositoryDir: string) {
  const piDir = join(repositoryDir, "pi");
  const piCommit = commandOutput(["git", "rev-parse", "HEAD"], piDir);
  if (piCommit !== PI_COMMIT) throw new Error(`Pi must be pinned to ${PI_COMMIT}; found ${piCommit}`);
  if (Bun.version !== BUN_VERSION) throw new Error(`Build with Bun ${BUN_VERSION}; found ${Bun.version}`);
  const tracked = commandOutput(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], repositoryDir).split("\0").filter(Boolean).sort();
  const sourceFiles = tracked.filter((path) => existsSync(join(repositoryDir, path))).map((path) => ({ path, sha256: sha256(readFileSync(join(repositoryDir, path))) }));
  const catalog = modelCatalogFiles(repositoryDir);
  const piSource = piSourceState(repositoryDir, catalog);
  const provenancePath = join(repositoryDir, "dist/pi-model-catalog/provenance.json");
  const recorded = existsSync(provenancePath) ? JSON.parse(readFileSync(provenancePath, "utf8")) : null;
  if (recorded && sha256(JSON.stringify(catalog)) !== recorded.catalogSha256) throw new Error("Model catalog differs from its recorded provenance; restore the matching snapshot");
  const generated = JSON.parse(readFileSync(join(piDir, "packages/ai/src/providers/data/.manifest.json"), "utf8"));
  return {
    source: { sha: commandOutput(["git", "rev-parse", "HEAD"], repositoryDir), dirty: Boolean(commandOutput(["git", "status", "--porcelain"], repositoryDir)), files: sourceFiles },
    tools: { bun: Bun.version, rustc: commandOutput(["rustc", "--version"], repositoryDir), cargo: commandOutput(["cargo", "--version"], repositoryDir), os: process.platform, hostArch: process.arch },
    pi: { commit: piCommit, ...piSource, patchFiles: inventory(join(repositoryDir, "pi-patches")), lockSha256: sha256(readFileSync(join(piDir, "bun.lock"))) },
    models: { catalogSha256: sha256(JSON.stringify(catalog)), files: catalog, provenance: recorded ?? { status: "existing-catalog-source-responses-unrecorded", generatedAt: generated.generatedAt ?? null } },
  };
}
