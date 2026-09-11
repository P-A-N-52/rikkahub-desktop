import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_RELEASE_REPOSITORY, parseReleaseRepository } from "../shared/release-source";
import { buildInputs } from "./build-provenance";
import { macSigning, packageMacApp, writeChecksums } from "./package-macos";

const repositoryDir = resolve(import.meta.dir, "../..");
const serverDir = join(repositoryDir, "pc-server");
const webDir = join(repositoryDir, "web-ui");
const tauriDir = join(webDir, "src-tauri");

import { desktopOutputNames, desktopTargets, type DesktopTarget } from "../shared/desktop-targets";
export { desktopOutputNames, desktopTargets, type DesktopTarget } from "../shared/desktop-targets";

interface TauriBuildConfig {
  productName: string;
  version: string;
  identifier: string;
  bundle?: { macOS?: { infoPlist?: string | null; minimumSystemVersion?: string } };
}

export function nativeMacTarget(arch: string = process.arch): DesktopTarget {
  const target = (Object.keys(desktopTargets) as DesktopTarget[])
    .find((key) => desktopTargets[key].platform === "mac" && desktopTargets[key].assetArch === arch);
  if (!target) throw new Error(`Unsupported macOS development architecture: ${arch}`);
  return target;
}

export function desktopTarget(value: string): DesktopTarget {
  if (!Object.hasOwn(desktopTargets, value)) {
    throw new Error(`Unsupported desktop target: ${value}. Expected ${Object.keys(desktopTargets).join(", ")}`);
  }
  return value as DesktopTarget;
}

/** Apple 的两个 plist 版本字段使用数字核心；应用展示、更新排序与资产名称仍使用完整 SemVer。 */
export function macBundleVersion(version: string): string {
  const numeric = version.split(/[-+]/, 1)[0] ?? "";
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(numeric)) {
    throw new Error(`Cannot map app version to a numeric macOS bundle version: ${version}`);
  }
  return numeric;
}

export function writeMacVersionPlist(version: string, output: string, source?: string): void {
  const numeric = macBundleVersion(version);
  // Tauri 会自动合并 src-tauri/Info.plist。若另配了 infoPlist，复制它后只覆盖版本字段，
  // 避免替换配置路径时丢失用途说明、URL schemes 等既有内容；不改动源 plist。
  if (source) copyFileSync(source, output);
  else writeFileSync(output, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>\n');
  for (const key of ["CFBundleVersion", "CFBundleShortVersionString"]) {
    run(["/usr/bin/plutil", "-replace", key, "-string", numeric, output], repositoryDir);
  }
}

export function parseDesktopBuildArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      bundles: { type: "string", default: "app,dmg" },
      "sidecar-only": { type: "boolean", default: false },
      "no-sign": { type: "boolean", default: false },
      "release-repository": { type: "string", default: DEFAULT_RELEASE_REPOSITORY },
      "signing-identity": { type: "string" },
      "notarize-profile": { type: "string" },
      "notarize-keychain": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return null;
  if (!values.target) throw new Error("--target is required; use --help to list supported targets");
  const target = desktopTarget(values.target);
  if (values.bundles !== "app" && values.bundles !== "app,dmg") {
    throw new Error("--bundles must be app or app,dmg");
  }
  if (!values["sidecar-only"] && desktopTargets[target].platform !== "mac") {
    throw new Error("Use --sidecar-only for Windows; its existing tauri:build command packages NSIS");
  }
  const releaseRepository = parseReleaseRepository(values["release-repository"]);
  const signing = macSigning(values["no-sign"], values["signing-identity"], values["notarize-profile"], values["notarize-keychain"]);
  if (values["sidecar-only"] && (values["signing-identity"] || values["notarize-profile"])) throw new Error("Signing options require a complete macOS app build");
  return { target, bundles: values.bundles, sidecarOnly: values["sidecar-only"], noSign: values["no-sign"], releaseRepository, signing };
}

function run(command: string[], cwd: string, capture = false): string {
  console.log(`$ ${command.join(" ")}`);
  const child = Bun.spawnSync(command, {
    cwd, stdin: "inherit", stdout: capture ? "pipe" : "inherit", stderr: "inherit",
  });
  if (child.exitCode !== 0) throw new Error(`${command[0]} failed with exit code ${child.exitCode}`);
  return child.stdout?.toString() ?? "";
}

export function buildDesktop(args: string[]) {
  const options = parseDesktopBuildArgs(args);
  if (!options) {
    console.log(`Usage: bun run scripts/build-desktop.ts --target <Rust triple> [--sidecar-only] [--bundles app|app,dmg] [--no-sign] [--release-repository owner/repo] [--signing-identity 'Developer ID Application: …'] [--notarize-profile name] [--notarize-keychain path]\nTargets: ${Object.keys(desktopTargets).join(", ")}`);
    return;
  }
  const target = desktopTargets[options.target];
  if (!options.sidecarOnly && process.platform !== "darwin") throw new Error("macOS app bundles must be built on macOS");
  if (!existsSync(join(repositoryDir, "pi/packages/ai/src/index.ts"))) {
    throw new Error("Pi vendor is missing; restore the documented Pi baseline and patches before building");
  }
  const inputs = options.sidecarOnly ? undefined : buildInputs(repositoryDir);
  if (options.signing.mode === "developer-id" && (inputs?.source.dirty || inputs?.pi.unexpectedChanges.length)) throw new Error("Developer ID builds require a clean reviewed source checkout and exact Pi baseline plus patches");
  const config = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8")) as TauriBuildConfig;
  const names = desktopOutputNames(options.target, config.productName, config.version);
  const outputDir = join(repositoryDir, "dist/desktop", options.target);
  // 保留 Windows 独立二进制路径；macOS 每个架构有独立的输出目录。
  const binary = target.platform === "windows" ? join(repositoryDir, "dist", names.binary) : join(outputDir, names.binary);
  const sidecar = join(tauriDir, "binaries", names.sidecar);
  mkdirSync(dirname(binary), { recursive: true });
  mkdirSync(dirname(sidecar), { recursive: true });

  const bun = process.execPath;
  run([bun, "run", "scripts/check-version-sync.ts"], serverDir);
  run([bun, "install", "--frozen-lockfile"], serverDir);
  if (target.platform === "windows") run([bun, "run", "scripts/build-bash-bundle.ts"], serverDir);
  run([bun, "build", "--compile", `--target=${target.bunTarget}`, "--define", `__RIKKAHUB_RELEASE_REPOSITORY__=${JSON.stringify(options.releaseRepository)}`, "server.ts", "--outfile", binary], serverDir);
  copyFileSync(binary, sidecar);
  console.log(`Sidecar: ${sidecar}`);
  if (options.sidecarOnly) return;

  run([bun, "install", "--frozen-lockfile"], webDir);
  const macConfig = JSON.parse(readFileSync(join(tauriDir, "tauri.macos.conf.json"), "utf8")) as Partial<TauriBuildConfig>;
  const macSettings = { ...config.bundle?.macOS, ...macConfig.bundle?.macOS };
  const versionPlist = join(outputDir, "Info.versions.plist");
  writeMacVersionPlist(config.version, versionPlist, macSettings.infoPlist ? resolve(tauriDir, macSettings.infoPlist) : undefined);
  // Tauri 执行公共 beforeBuildCommand 生成前端；这里不再重复构建前端。
  const tauriArgs = [bun, "run", "tauri", "build", "--target", options.target, "--bundles", "app", "--no-sign",
    "--config", JSON.stringify({ bundle: { macOS: { infoPlist: versionPlist } } })];
  run([...tauriArgs, "--", "--locked"], webDir);

  const metadata = JSON.parse(run(["cargo", "metadata", "--no-deps", "--format-version", "1", "--locked"], tauriDir, true)) as { target_directory: string };
  const bundleDir = join(metadata.target_directory, options.target, "release/bundle");
  const app = join(bundleDir, "macos", names.app);
  if (!existsSync(app)) throw new Error(`Tauri did not produce the expected app: ${app}`);
  const packaged = packageMacApp({
    repositoryDir, tauriDir, app, target: options.target,
    expected: { identifier: config.identifier, version: macBundleVersion(config.version), minimumSystemVersion: macSettings.minimumSystemVersion ?? "10.13" },
    archive: join(outputDir, names.appArchive),
    ...(options.bundles === "app,dmg" ? { dmg: join(outputDir, names.dmg) } : {}), signing: options.signing,
  });
  const manifestName = names.appArchive.replace(/\.app\.zip$/, ".manifest.json");
  writeChecksums(outputDir, manifestName, {
    schemaVersion: 1, builtAt: new Date().toISOString(), target: options.target, version: config.version,
    releaseRepository: options.releaseRepository, ...inputs, ...packaged,
  });
  console.log(`App: ${app}\nArtifacts and SHA256SUMS: ${outputDir}`);
}

if (import.meta.main) {
  try {
    buildDesktop(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
