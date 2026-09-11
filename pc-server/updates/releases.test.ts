import { describe, expect, test } from "bun:test";
import { DEFAULT_RELEASE_REPOSITORY } from "../shared/release-source";
import { discoverRelease, isNewerRelease, macInstallerName, normalizeReleaseVersion, pickReleaseAsset, UPDATE_R2_BASE, type UpdateTarget } from "./releases";

const repo = "fixture/rikkahub";
const mac: UpdateTarget = { platform: "mac", architecture: "arm64", containerized: false };
const version = "2.1.0-preview.2+build.7";
const asset = (name: string) => ({ name, size: 12, browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}` });
const arm = asset(`Rikkahub_${version}_mac_arm64.dmg`);
const intel = asset(`Rikkahub_${version}_mac_x64.dmg`);
const release = { tag_name: `v${version}`, name: "Fixture", body: "Local fixture", assets: [intel, arm] };

describe("release targets and versions", () => {
  test("macOS selects the exact current architecture independent of asset order", () => {
    expect(pickReleaseAsset(release, mac)).toEqual(arm);
    expect(pickReleaseAsset(release, { ...mac, architecture: "x64" })).toEqual(intel);
    expect(macInstallerName(`v${version}`, "arm64")).toBe(arm.name);
  });
  test("missing, unknown and lookalike macOS assets are not guessed", () => {
    const wrong = { ...release, assets: [intel, asset("first.dmg"), asset(`${arm.name}.zip`)] };
    expect(pickReleaseAsset(wrong, mac)).toBeUndefined();
    expect(pickReleaseAsset(release, { ...mac, architecture: "universal" })).toBeUndefined();
    expect(pickReleaseAsset(release, { ...mac, containerized: true })).toBeUndefined();
  });
  test("existing Windows and Linux asset conventions remain available", () => {
    const win = asset("Rikkahub_2.1.0_x64-setup.exe");
    const linux = asset("Rikkahub_2.1.0_linux_x64.tar.gz");
    const source = { tag_name: "v2.1.0", assets: [asset("other.exe"), linux, win] };
    expect(pickReleaseAsset(source, { ...mac, platform: "win", architecture: "x64" })).toEqual(win);
    expect(pickReleaseAsset(source, { ...mac, platform: "linux", architecture: "x64" })).toEqual(linux);
  });
  test("prerelease upgrades use semantic order and ignore build metadata for ordering", () => {
    expect(isNewerRelease("2.0.0", "2.0.0-preview-v2")).toBe(true);
    expect(isNewerRelease("2.0.0-preview.10", "2.0.0-preview.2")).toBe(true);
    expect(isNewerRelease("2.0.0-preview-v2", "2.0.0")).toBe(false);
    expect(isNewerRelease("2.0.0+build.2", "2.0.0+build.1")).toBe(false);
    expect(normalizeReleaseVersion(` v${version} `)).toBe(version);
  });
  test("invalid version and path tokens cannot become asset names", () => {
    for (const value of ["", "2.0", "02.0.0", "2.0.0-01", "2.0.0-alpha..2", "2.0.0/evil", "2.0.0+", "../2.0.0"]) {
      expect(() => normalizeReleaseVersion(value)).toThrow("Invalid release version");
    }
  });
});

describe("release discovery with injected local responses", () => {
  function responses(head: Response | Error, api: Response | Error) {
    const calls: string[] = [];
    return { calls, request: async (url: string | URL) => {
      const value = String(url);
      calls.push(value);
      const reply = value.startsWith("https://api.github.com/") ? api : head;
      if (reply instanceof Error) throw reply;
      return reply.clone();
    } };
  }
  const redirect = () => new Response(null, { status: 302, headers: { location: `/${repo}/releases/tag/v${version}` } });

  test("API metadata confirms both the macOS asset and its optional SHA-256", async () => {
    const sha256 = "ab".repeat(32);
    const f = responses(redirect(), Response.json({ ...release, assets: [intel, { ...arm, digest: `sha256:${sha256}` }] }));
    expect(await discoverRelease(repo, mac, "2.0.0", f.request)).toMatchObject({ latest: version, fileName: arm.name, downloadUrl: arm.browser_download_url, sha256, source: "api" });
    expect(f.calls).toHaveLength(2);
  });
  test("up-to-date HTML redirect avoids API calls", async () => {
    const f = responses(redirect(), new Error("API must not run"));
    expect(await discoverRelease(repo, mac, "2.2.0", f.request)).toMatchObject({ latest: version, downloadUrl: "", fileName: "", source: "redirect" });
    expect(f.calls).toHaveLength(1);
  });
  test("rate limiting offers the known release page without guessing a macOS download", async () => {
    const f = responses(redirect(), new Response(null, { status: 403 }));
    expect(await discoverRelease(repo, mac, "2.0.0", f.request)).toMatchObject({ latest: version, downloadUrl: "", fileName: "", size: 0, source: "redirect" });
  });
  test("missing architecture is reported as a release with no downloadable asset", async () => {
    const f = responses(redirect(), Response.json({ ...release, assets: [intel] }));
    expect(await discoverRelease(repo, mac, "2.0.0", f.request)).toMatchObject({ latest: version, downloadUrl: "", fileName: "", size: 0 });
  });
  test("API still works when the HTML redirect is unavailable", async () => {
    const f = responses(new Error("offline redirect"), Response.json(release));
    expect((await discoverRelease(repo, mac, "2.0.0", f.request)).fileName).toBe(arm.name);
  });
  test("failure of both endpoints is an error, never a fabricated release", async () => {
    const f = responses(new Error("network"), new Response(null, { status: 503 }));
    await expect(discoverRelease(repo, mac, "2.0.0", f.request)).rejects.toThrow("无法获取 GitHub 发布信息");
  });
  test("external redirect does not provide a trusted release fallback", async () => {
    const f = responses(new Response(null, { status: 302, headers: { location: `https://example.org/${repo}/releases/tag/v${version}` } }), new Response(null, { status: 403 }));
    await expect(discoverRelease(repo, mac, "2.0.0", f.request)).rejects.toThrow();
  });
  test("GitHub canonical repository casing does not invalidate the release redirect", async () => {
    const f = responses(new Response(null, { status: 302, headers: { location: `/Fixture/RikkaHub/releases/tag/v${version}` } }), new Response(null, { status: 403 }));
    expect(await discoverRelease("FIXTURE/rikkahub", mac, "2.0.0", f.request)).toMatchObject({ latest: version, source: "redirect", fileName: "" });
  });
  test("Windows fork releases never use the upstream R2 mirror", async () => {
    const name = "Rikkahub_2.1.0_x64-setup.exe";
    const data = { tag_name: "v2.1.0", assets: [asset(name)] };
    const f = responses(new Error("redirect"), Response.json(data));
    const target = { ...mac, platform: "win" as const, architecture: "x64" };
    expect((await discoverRelease(repo, target, "2.0.0", f.request)).downloadUrl).toBe(asset(name).browser_download_url);
    expect((await discoverRelease(DEFAULT_RELEASE_REPOSITORY, target, "2.0.0", f.request)).downloadUrl).toBe(`${UPDATE_R2_BASE}/${name}`);
  });
});
