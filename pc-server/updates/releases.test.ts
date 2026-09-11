import { describe, expect, test } from "bun:test";
import { discoverRelease, isNewerRelease, macInstallerName, normalizeReleaseVersion, pickReleaseAsset, RELEASE_REPOSITORY, UPDATE_R2_BASE, type UpdateTarget } from "./releases";

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
  test.each([
    ["P-A-N-52/rikkahub-desktop", false],
    ["yuh-G/rikkahub-desktop", true],
    ["YUH-G/RIKKAHUB-DESKTOP", true],
  ] as const)("Windows downloads from %s use only that repository's source", async (repository, upstreamMirror) => {
    const name = "Rikkahub_2.1.0_x64-setup.exe";
    const githubUrl = `https://github.com/${repository}/releases/download/v2.1.0/${name}`;
    const data = { tag_name: "v2.1.0", assets: [{ name, size: 12, browser_download_url: githubUrl }] };
    const target = { ...mac, platform: "win" as const, architecture: "x64" };
    for (const apiAvailable of [true, false]) {
      const head = new Response(null, { status: 302, headers: { location: `/${repository}/releases/tag/v2.1.0` } });
      const f = responses(head, apiAvailable ? Response.json(data) : new Response(null, { status: 403 }));
      expect((await discoverRelease(repository, target, "2.0.0", f.request)).downloadUrl)
        .toBe(upstreamMirror ? `${UPDATE_R2_BASE}/${name}` : githubUrl);
      expect(f.calls).toEqual([`https://github.com/${repository}/releases/latest`, `https://api.github.com/repos/${repository}/releases/latest`]);
    }
  });

  test("the default macOS update check and asset stay in this fork", async () => {
    expect(RELEASE_REPOSITORY).toBe("P-A-N-52/rikkahub-desktop");
    const downloadUrl = `https://github.com/P-A-N-52/rikkahub-desktop/releases/download/v${version}/${encodeURIComponent(arm.name)}`;
    const f = responses(new Error("HTML latest must not run"), Response.json([
      { ...release, assets: [{ ...arm, browser_download_url: downloadUrl }] },
    ]));
    expect(await discoverRelease(RELEASE_REPOSITORY, mac, "2.0.0-preview-v2", f.request)).toMatchObject({ downloadUrl, fileName: arm.name });
    expect(f.calls).toEqual(["https://api.github.com/repos/P-A-N-52/rikkahub-desktop/releases?per_page=100&page=1"]);
  });

  test("a macOS preview discovers the repository's only prerelease with its exact asset and digest", async () => {
    const sha256 = "cd".repeat(32);
    const f = responses(new Error("HTML latest must not run"), Response.json([
      { ...release, prerelease: true, draft: false, assets: [intel, { ...arm, digest: `sha256:${sha256}` }] },
    ]));
    expect(await discoverRelease(repo, mac, version, f.request)).toMatchObject({
      latest: version, fileName: arm.name, downloadUrl: arm.browser_download_url, sha256, source: "api",
    });
    expect(f.calls).toEqual([`https://api.github.com/repos/${repo}/releases?per_page=100&page=1`]);
  });

  test("macOS previews choose the highest SemVer regardless of publication order, drafts or invalid tags", async () => {
    const releases = [
      { tag_name: "v2.0.0-preview.2", prerelease: true },
      { tag_name: "v99.0.0", draft: true },
      { tag_name: "v2.0.0-preview.10", prerelease: true },
      { tag_name: "nightly" }, { tag_name: "v3.0.0-01" }, null,
      { tag_name: "v1.9.0", prerelease: false },
    ];
    const f = responses(new Error("HTML latest must not run"), Response.json(releases));
    expect((await discoverRelease(repo, mac, "2.0.0-preview.1", f.request)).latest).toBe("2.0.0-preview.10");
    const stable = responses(new Error("HTML latest must not run"), Response.json([
      ...releases, { tag_name: "v2.0.0", prerelease: false },
    ]));
    expect((await discoverRelease(repo, mac, "2.0.0-preview.1", stable.request)).latest).toBe("2.0.0");
  });

  test("macOS preview discovery scans subsequent pages before selecting a release", async () => {
    const calls: string[] = [];
    const request = async (url: string | URL) => {
      calls.push(String(url));
      const page = new URL(url).searchParams.get("page");
      if (page === "1") return Response.json(Array.from({ length: 100 }, (_, n) => ({ tag_name: `v1.0.0-preview.${n}` })));
      if (page === "2") return Response.json([release]);
      throw new Error("Unexpected release request");
    };
    expect((await discoverRelease(repo, mac, "2.0.0-preview-v2", request)).fileName).toBe(arm.name);
    expect(calls).toEqual([1, 2].map((page) => `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`));
  });

  test("macOS preview failure or an empty valid-release set is an error without redirect or guessed DMG", async () => {
    for (const reply of [
      new Error("network"), new Response(null, { status: 403 }), new Response("invalid JSON"),
      Response.json({ message: "not a release list" }), Response.json([]),
      Response.json([{ tag_name: "v99.0.0", draft: true }, { tag_name: "nightly" }]),
    ]) {
      const f = responses(redirect(), reply);
      await expect(discoverRelease(repo, mac, "2.0.0-preview-v2", f.request)).rejects.toThrow("无法获取 GitHub 发布信息");
      expect(f.calls).toEqual([`https://api.github.com/repos/${repo}/releases?per_page=100&page=1`]);
    }
  });

  test("failure on a later release page does not report a partial result as the newest version", async () => {
    const request = async (url: string | URL) => new URL(url).searchParams.get("page") === "1"
      ? Response.json(Array.from({ length: 100 }, () => release)) : new Response(null, { status: 503 });
    await expect(discoverRelease(repo, mac, "2.0.0-preview-v2", request)).rejects.toThrow("无法获取 GitHub 发布信息");
  });

  test("a macOS preview never substitutes an Intel or unconfirmed asset", async () => {
    const f = responses(new Error("HTML latest must not run"), Response.json([{ ...release, assets: [intel] }]));
    expect(await discoverRelease(repo, mac, "2.0.0-preview-v2", f.request)).toMatchObject({
      latest: version, fileName: "", downloadUrl: "", size: 0, source: "api",
    });
  });

  test("stable macOS, including hyphenated build metadata, and other platforms keep the latest endpoint", async () => {
    for (const [target, current] of [
      [mac, "2.0.0"], [mac, "2.0.0+build-preview"],
      [{ ...mac, platform: "win" as const }, "2.0.0-preview-v2"],
      [{ ...mac, platform: "linux" as const }, "2.0.0-preview-v2"],
    ] as const) {
      const f = responses(redirect(), Response.json(release));
      expect((await discoverRelease(repo, target, current, f.request)).latest).toBe(version);
      expect(f.calls).toEqual([`https://github.com/${repo}/releases/latest`, `https://api.github.com/repos/${repo}/releases/latest`]);
    }
  });
});
