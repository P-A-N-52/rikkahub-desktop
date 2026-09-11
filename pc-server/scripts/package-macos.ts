import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { commandOutput, inventory, sha256 } from "./build-provenance";
import { desktopTargets, type DesktopTarget } from "../shared/desktop-targets";

export type MacSigning = { mode: "none" | "adhoc" | "developer-id"; identity?: string; notarizeProfile?: string; notarizeKeychain?: string };
export function macSigning(noSign: boolean, identity?: string, notarizeProfile?: string, notarizeKeychain?: string): MacSigning {
  if (noSign && (identity || notarizeProfile)) throw new Error("--no-sign cannot be combined with a signing identity or notarization");
  if (identity && !identity.startsWith("Developer ID Application: ")) throw new Error("--signing-identity must be a Developer ID Application identity");
  if (notarizeProfile && !identity) throw new Error("--notarize-profile requires --signing-identity");
  if (notarizeKeychain && !notarizeProfile) throw new Error("--notarize-keychain requires --notarize-profile");
  return { mode: noSign ? "none" : identity ? "developer-id" : "adhoc", ...(identity ? { identity } : {}), ...(notarizeProfile ? { notarizeProfile } : {}), ...(notarizeKeychain ? { notarizeKeychain } : {}) };
}

function run(command: string[], cwd: string) {
  console.log(`$ ${command.join(" ")}`);
  const child = Bun.spawnSync(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (child.exitCode !== 0) throw new Error(`${command[0]} failed with exit code ${child.exitCode}`);
}

export function assertMinimumSystemVersion(declared: string, binaries: { name: string; minimumSystemVersion: string | null }[]) {
  const version = (value: string) => {
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid minimum macOS version: ${value}`);
    const [major, minor, patch = 0] = value.split(".").map(Number);
    return major! * 1_000_000 + minor! * 1_000 + patch;
  };
  const minimum = version(declared);
  for (const binary of binaries) {
    if (!binary.minimumSystemVersion || version(binary.minimumSystemVersion) > minimum) {
      throw new Error(`${binary.name} requires macOS ${binary.minimumSystemVersion ?? "unknown"}, above declared ${declared}`);
    }
  }
}

export function validateMacApp(app: string, target: DesktopTarget, expected?: { identifier: string; version: string; minimumSystemVersion: string }) {
  app = resolve(app);
  const sidecar = join(app, "Contents/MacOS/rikkahub-server");
  const plist = JSON.parse(commandOutput(["/usr/bin/plutil", "-convert", "json", "-o", "-", join(app, "Contents/Info.plist")], app));
  if (!/^[A-Za-z0-9_-]+$/.test(plist.CFBundleExecutable ?? "")) throw new Error("App has an invalid executable name");
  const main = join(app, "Contents/MacOS", plist.CFBundleExecutable);
  const expectedArch = desktopTargets[target].assetArch === "arm64" ? "arm64" : "x86_64";
  const executables = [main, sidecar].map((path) => {
    const arch = commandOutput(["/usr/bin/lipo", "-archs", path], app);
    if (arch !== expectedArch) throw new Error(`Architecture mismatch for ${basename(path)}: expected ${expectedArch}, found ${arch}`);
    const loadCommands = commandOutput(["/usr/bin/otool", "-l", path], app);
    const minimum = loadCommands.match(/\bminos\s+(\d+\.\d+(?:\.\d+)?)/)?.[1]
      ?? loadCommands.match(/cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+\.\d+(?:\.\d+)?)/)?.[1];
    return { name: basename(path), architecture: arch, minimumSystemVersion: minimum ?? null };
  });
  for (const required of ["Contents/Resources/web-ui/build/client/index.html", "Contents/Resources/icons", "Contents/Resources/fonts"]) {
    if (!existsSync(join(app, required))) throw new Error(`App resource missing: ${required}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(plist.CFBundleVersion ?? "") || plist.CFBundleVersion !== plist.CFBundleShortVersionString) throw new Error("App bundle versions must use the same numeric version");
  if (expected && (plist.CFBundleIdentifier !== expected.identifier || plist.CFBundleVersion !== expected.version || plist.LSMinimumSystemVersion !== expected.minimumSystemVersion)) throw new Error("App identity, version, or deployment target differs from build configuration");
  assertMinimumSystemVersion(plist.LSMinimumSystemVersion, executables);
  if (!plist.NSMicrophoneUsageDescription) throw new Error("App is missing its microphone usage description");
  return { identifier: plist.CFBundleIdentifier, version: plist.CFBundleShortVersionString, build: plist.CFBundleVersion,
    minimumSystemVersion: plist.LSMinimumSystemVersion, executables, files: inventory(app) };
}

function archiveApp(app: string, archive: string, cwd: string) {
  rmSync(archive, { force: true });
  run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive], cwd);
}

/** Tauri creates the app first; sign its Bun child separately before sealing outer resources. */
export function packageMacApp(options: {
  repositoryDir: string; tauriDir: string; app: string; target: DesktopTarget;
  archive: string; dmg?: string; signing: MacSigning; expected: { identifier: string; version: string; minimumSystemVersion: string };
}) {
  const { repositoryDir, tauriDir, app, archive, dmg, signing, target } = options;
  validateMacApp(app, target, options.expected);
  if (signing.mode !== "none") {
    const signingArgs = ["--force", "--sign", signing.identity ?? "-", "--options", "runtime",
      signing.mode === "developer-id" ? "--timestamp" : "--timestamp=none"];
    run(["/usr/bin/codesign", ...signingArgs, "--entitlements", join(tauriDir, "Entitlements.sidecar.plist"), join(app, "Contents/MacOS/rikkahub-server")], repositoryDir);
    run(["/usr/bin/codesign", ...signingArgs, "--entitlements", join(tauriDir, "Entitlements.app.plist"), app], repositoryDir);
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app], repositoryDir);
  }
  const notaryKeychain = signing.notarizeKeychain ? ["--keychain", signing.notarizeKeychain] : [];
  archiveApp(app, archive, repositoryDir);
  if (signing.notarizeProfile) {
    run(["/usr/bin/xcrun", "notarytool", "submit", archive, "--keychain-profile", signing.notarizeProfile, ...notaryKeychain, "--wait"], repositoryDir);
    run(["/usr/bin/xcrun", "stapler", "staple", app], repositoryDir);
    run(["/usr/bin/xcrun", "stapler", "validate", app], repositoryDir);
    run(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=2", app], repositoryDir);
    archiveApp(app, archive, repositoryDir);
  }
  if (dmg) {
    const staging = mkdtempSync(join(tmpdir(), "rikkahub-dmg-"));
    try {
      run(["/usr/bin/ditto", app, join(staging, basename(app))], repositoryDir);
      symlinkSync("/Applications", join(staging, "Applications"));
      // A plain Applications alias is stable on both architectures and requires no Finder automation in CI.
      run(["/usr/bin/hdiutil", "create", "-volname", "Rikkahub", "-srcfolder", staging, "-format", "UDZO", "-ov", dmg], repositoryDir);
    } finally { rmSync(staging, { recursive: true, force: true }); }
    if (signing.mode === "developer-id") run(["/usr/bin/codesign", "--sign", signing.identity!, "--timestamp", dmg], repositoryDir);
    if (signing.notarizeProfile) {
      run(["/usr/bin/xcrun", "notarytool", "submit", dmg, "--keychain-profile", signing.notarizeProfile, ...notaryKeychain, "--wait"], repositoryDir);
      run(["/usr/bin/xcrun", "stapler", "staple", dmg], repositoryDir);
      run(["/usr/bin/xcrun", "stapler", "validate", dmg], repositoryDir);
    }
    run(["/usr/bin/hdiutil", "verify", dmg], repositoryDir);
  }
  const artifacts = [archive, ...(dmg ? [dmg] : [])].map((path) => ({ name: basename(path), bytes: Bun.file(path).size, sha256: sha256(readFileSync(path)) }));
  return { app: validateMacApp(app, target, options.expected), signing: { mode: signing.mode, hardenedRuntime: signing.mode !== "none", notarized: Boolean(signing.notarizeProfile) }, artifacts };
}

export function writeChecksums(outputDir: string, manifestName: string, manifest: { artifacts: { name: string; sha256: string }[]; [key: string]: unknown }) {
  mkdirSync(outputDir, { recursive: true });
  const data = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(outputDir, manifestName), data);
  const checksums = [...manifest.artifacts, { name: manifestName, sha256: sha256(data) }];
  writeFileSync(join(outputDir, "SHA256SUMS"), checksums.map((entry) => `${entry.sha256}  ${entry.name}\n`).join(""));
}
