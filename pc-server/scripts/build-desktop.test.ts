import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopOutputNames, desktopTargets, macBundleVersion, parseDesktopBuildArgs, writeMacVersionPlist } from "./build-desktop";

describe("desktop build target contract", () => {
  test("Windows retains its executable and sidecar names", () => {
    const names = desktopOutputNames("x86_64-pc-windows-msvc", "Rikkahub", "2.0.0-preview");
    expect(names.binary).toBe("rikkahub-pc.exe");
    expect(names.sidecar).toBe("rikkahub-server-x86_64-pc-windows-msvc.exe");
    expect(parseDesktopBuildArgs(["--target", "x86_64-pc-windows-msvc", "--sidecar-only"])?.sidecarOnly).toBe(true);
  });

  test("macOS architectures select distinct Bun, sidecar and asset names", () => {
    const arm = desktopOutputNames("aarch64-apple-darwin", "Rikkahub", "2.0.0-preview");
    const intel = desktopOutputNames("x86_64-apple-darwin", "Rikkahub", "2.0.0-preview");
    expect(desktopTargets["aarch64-apple-darwin"].bunTarget).toBe("bun-darwin-arm64");
    expect(desktopTargets["x86_64-apple-darwin"].bunTarget).toBe("bun-darwin-x64");
    expect(arm.sidecar).toBe("rikkahub-server-aarch64-apple-darwin");
    expect(intel.sidecar).toBe("rikkahub-server-x86_64-apple-darwin");
    expect(arm.dmg).toBe("Rikkahub_2.0.0-preview_mac_arm64.dmg");
    expect(intel.dmg).toBe("Rikkahub_2.0.0-preview_mac_x64.dmg");
    expect(arm.appArchive).not.toBe(intel.appArchive);
  });

  test("CI can build only the app without signing", () => {
    expect(parseDesktopBuildArgs(["--target", "aarch64-apple-darwin", "--bundles", "app", "--no-sign"])).toEqual({
      target: "aarch64-apple-darwin", bundles: "app", sidecarOnly: false, noSign: true,
      releaseRepository: "yuh-G/rikkahub-desktop", signing: { mode: "none" },
    });
  });

  test("Apple bundle fields use the numeric core while assets retain prerelease labels", () => {
    expect(macBundleVersion("2.0.0-preview")).toBe("2.0.0");
    expect(macBundleVersion("2.1.3-beta.2+build.42")).toBe("2.1.3");
    expect(macBundleVersion("1.2.3")).toBe("1.2.3");
    expect(() => macBundleVersion("2.0")).toThrow("numeric macOS bundle version");
    expect(() => macBundleVersion("2.0.preview")).toThrow("numeric macOS bundle version");
    expect(desktopOutputNames("aarch64-apple-darwin", "Rikkahub", "2.0.0-preview").dmg)
      .toBe("Rikkahub_2.0.0-preview_mac_arm64.dmg");
  });

  test.skipIf(process.platform !== "darwin")("version overlay preserves configured plist fields and its source file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rikkahub-version-plist-"));
    try {
      const source = join(dir, "source.plist");
      const original = '<?xml version="1.0"?><plist version="1.0"><dict><key>NSMicrophoneUsageDescription</key><string>Record requested audio</string><key>FutureSettings</key><dict><key>enabled</key><true/></dict><key>CFBundleVersion</key><string>old</string></dict></plist>';
      writeFileSync(source, original);
      for (const configured of [undefined, source]) {
        const output = join(dir, configured ? "configured.plist" : "minimal.plist");
        writeMacVersionPlist("2.0.0-preview", output, configured);
        const converted = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", output]);
        expect(converted.exitCode).toBe(0);
        const plist = JSON.parse(converted.stdout.toString());
        expect(plist.CFBundleVersion).toBe("2.0.0");
        expect(plist.CFBundleShortVersionString).toBe("2.0.0");
        if (configured) {
          expect(plist.NSMicrophoneUsageDescription).toBe("Record requested audio");
          expect(plist.FutureSettings).toEqual({ enabled: true });
        }
      }
      expect(readFileSync(source, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid requests fail before installing dependencies or building", () => {
    expect(() => parseDesktopBuildArgs([])).toThrow("--target is required");
    expect(() => parseDesktopBuildArgs(["--target", "universal-apple-darwin"])).toThrow("Unsupported desktop target");
    expect(() => parseDesktopBuildArgs(["--target", "aarch64-apple-darwin", "--bundles", "nsis"])).toThrow("--bundles must be");
    expect(() => parseDesktopBuildArgs(["--target", "x86_64-pc-windows-msvc"])).toThrow("--sidecar-only");
    expect(() => parseDesktopBuildArgs(["--unknown"])).toThrow();
    expect(parseDesktopBuildArgs(["--help"])).toBeNull();
  });
});
