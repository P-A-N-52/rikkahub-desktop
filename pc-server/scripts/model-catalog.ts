import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUN_VERSION, commandOutput, modelCatalogFiles, PI_COMMIT, sha256, type FileRecord } from "./build-provenance";

const repositoryDir = resolve(import.meta.dir, "../..");
const catalogRoot = join(repositoryDir, "pi/packages/ai/src");
const output = join(repositoryDir, "dist/pi-model-catalog");

export function validateCatalogRecords(records: FileRecord[]): void {
  if (!records.length) throw new Error("Model snapshot has no files");
  const paths = new Set<string>();
  for (const record of records) {
    if (!/^(models\.generated\.ts|providers\/[a-zA-Z0-9_-]+\.models\.ts|providers\/data\/(?:[a-zA-Z0-9_-]+|\.manifest)\.json)$/.test(record.path)
      || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "") || paths.has(record.path)) throw new Error(`Invalid model snapshot record: ${record.path}`);
    paths.add(record.path);
  }
  if (!paths.has("models.generated.ts") || !paths.has("providers/data/.manifest.json")) throw new Error("Model snapshot is incomplete");
}

/** Stage the complete provider directory so original catalog bytes survive failed writes or renames. */
export function restoreCatalog(root: string, snapshot: string, files: FileRecord[], operations = { copy: copyFileSync, rename: renameSync }) {
  validateCatalogRecords(files);
  for (const record of files) {
    if (sha256(readFileSync(join(snapshot, record.path))) !== record.sha256) throw new Error(`Model snapshot checksum mismatch: ${record.path}`);
  }
  const staging = mkdtempSync(join(dirname(root), ".catalog-restore-"));
  const providers = join(root, "providers");
  const aggregator = join(root, "models.generated.ts");
  const previousProviders = join(staging, "previous-providers");
  const previousAggregator = join(staging, "previous-models.generated.ts");
  let movedProviders = false, movedAggregator = false, installedProviders = false, installedAggregator = false;
  let preserveRecovery = false;
  try {
    cpSync(providers, join(staging, "providers"), { recursive: true });
    rmSync(join(staging, "providers/data"), { recursive: true, force: true });
    for (const name of readdirSync(join(staging, "providers"))) if (name.endsWith(".models.ts")) rmSync(join(staging, "providers", name));
    for (const { path } of files) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      operations.copy(join(snapshot, path), join(staging, path));
    }
    for (const record of files) {
      if (sha256(readFileSync(join(staging, record.path))) !== record.sha256) throw new Error(`Staged model checksum mismatch: ${record.path}`);
    }
    operations.rename(providers, previousProviders); movedProviders = true;
    operations.rename(aggregator, previousAggregator); movedAggregator = true;
    operations.rename(join(staging, "providers"), providers); installedProviders = true;
    operations.rename(join(staging, "models.generated.ts"), aggregator); installedAggregator = true;
  } catch (error) {
    try {
      if (installedAggregator) rmSync(aggregator);
      if (installedProviders) rmSync(providers, { recursive: true });
      if (movedAggregator) operations.rename(previousAggregator, aggregator);
      if (movedProviders) operations.rename(previousProviders, providers);
    } catch (rollbackError) {
      preserveRecovery = true;
      throw new AggregateError([error, rollbackError], `Model restore rollback failed; original files retained in ${staging}`);
    }
    throw error;
  } finally {
    if (!preserveRecovery) rmSync(staging, { recursive: true, force: true });
  }
}

export function runModelCatalog(action: string) {
  if (Bun.version !== BUN_VERSION) throw new Error(`Model catalog requires Bun ${BUN_VERSION}`);
  const piCommit = commandOutput(["git", "rev-parse", "HEAD"], join(repositoryDir, "pi"));
  if (piCommit !== PI_COMMIT) throw new Error(`Model catalog requires Pi ${PI_COMMIT}`);
  if (action === "generate") {
    // Never overwrite an earlier capture silently; a build should retain its exact catalog.
    if (existsSync(output)) throw new Error(`Model snapshot already exists: ${output}`);
    mkdirSync(output, { recursive: true });
    const sourcesDir = join(output, "sources");
    const child = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "model-fetch-recorder.ts"),
      "scripts/generate-models.ts", "--strict"], {
      cwd: join(repositoryDir, "pi/packages/ai"), env: { ...process.env, RIKKAHUB_MODEL_SOURCE_DIR: sourcesDir },
      stdout: "inherit", stderr: "inherit",
    });
    if (child.exitCode !== 0) throw new Error("Pi model generation failed; source receipts retained for diagnosis");
    const sources = JSON.parse(readFileSync(join(sourcesDir, "sources.json"), "utf8")) as { status: number }[];
    if (!sources.length || sources.some((source) => source.status !== 200)) throw new Error("Incomplete public source receipts");
    const files = modelCatalogFiles(repositoryDir);
    validateCatalogRecords(files);
    for (const { path } of files) {
      const destination = join(output, "catalog", path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(catalogRoot, path), destination);
    }
    const generated = JSON.parse(readFileSync(join(catalogRoot, "providers/data/.manifest.json"), "utf8"));
    writeFileSync(join(output, "provenance.json"), `${JSON.stringify({
      schemaVersion: 1, status: "captured-public-sources", piCommit, bun: Bun.version,
      capturedAt: new Date().toISOString(), generatedAt: generated.generatedAt ?? null,
      generatorSha256: sha256(readFileSync(join(repositoryDir, "pi/packages/ai/scripts/generate-models.ts"))),
      catalogSha256: sha256(JSON.stringify(files)), files, sources,
    }, null, 2)}\n`);
  } else if (action === "restore") {
    const provenance = JSON.parse(readFileSync(join(output, "provenance.json"), "utf8"));
    if (provenance.piCommit !== piCommit || provenance.bun !== Bun.version) throw new Error("Model snapshot uses a different Pi/Bun baseline");
    const files = provenance.files as FileRecord[];
    validateCatalogRecords(files);
    if (sha256(JSON.stringify(files)) !== provenance.catalogSha256) throw new Error("Model snapshot inventory checksum mismatch");
    restoreCatalog(catalogRoot, join(output, "catalog"), files);
  } else throw new Error("Usage: bun run scripts/model-catalog.ts generate|restore");
  console.log(`Model catalog ${action}: ${output}`);
}

if (import.meta.main) {
  try { runModelCatalog(process.argv[2] ?? ""); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
