import type { GithubRelease } from "../foundation/types";
import { fetchWithTimeout } from "../foundation/net";
import { desktopOutputNames } from "../shared/desktop-targets";
import { DEFAULT_RELEASE_REPOSITORY, parseReleaseRepository } from "../shared/release-source";

declare const __RIKKAHUB_RELEASE_REPOSITORY__: string | undefined;

// Build-time only: an installed application cannot be redirected by its environment.
export const RELEASE_REPOSITORY = parseReleaseRepository(
  typeof __RIKKAHUB_RELEASE_REPOSITORY__ === "undefined"
    ? DEFAULT_RELEASE_REPOSITORY : __RIKKAHUB_RELEASE_REPOSITORY__,
);
export const UPDATE_R2_BASE = "https://pub-d26eee7d911c4bab937ebe1729a4cefe.r2.dev";

export interface UpdateTarget {
  platform: "win" | "mac" | "linux";
  architecture: string;
  containerized: boolean;
}

export function normalizeReleaseVersion(value: string): string {
  const version = value.trim().replace(/^v/i, "");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) {
    throw new Error("Invalid release version");
  }
  return version;
}

export function isNewerRelease(latest: string, current: string): boolean {
  return Bun.semver.order(normalizeReleaseVersion(latest), normalizeReleaseVersion(current)) > 0;
}

export function macInstallerName(version: string, architecture: string): string | null {
  const target = architecture === "arm64" ? "aarch64-apple-darwin"
    : architecture === "x64" ? "x86_64-apple-darwin" : null;
  return target ? desktopOutputNames(target, "Rikkahub", normalizeReleaseVersion(version)).dmg : null;
}

export function pickReleaseAsset(release: GithubRelease, target: UpdateTarget) {
  if (target.containerized) return undefined;
  const assets = release.assets ?? [];
  if (target.platform === "mac") {
    const name = macInstallerName(release.tag_name ?? "", target.architecture);
    return name ? assets.find((asset) => asset.name === name) : undefined;
  }
  if (target.platform === "linux") return assets.find((asset) => /linux[-_]x64.*\.tar\.gz$/i.test(asset.name ?? ""));
  return assets.find((asset) => /x64[-_]setup\.exe$/i.test(asset.name ?? ""))
    ?? assets.find((asset) => /\.exe$/i.test(asset.name ?? ""));
}

export interface ReleaseMetadata {
  latest: string;
  title: string;
  notes: string;
  htmlUrl: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  sha256?: string;
  source: "api" | "redirect";
}

type ReleaseFetch = typeof fetchWithTimeout;

export async function fetchGithubLatestRelease(repo: string, request: ReleaseFetch = fetchWithTimeout): Promise<GithubRelease> {
  const res = await request(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "RikkaHub-PC" },
  });
  if (!res.ok) throw new Error(`GitHub release request failed: ${res.status}`);
  return await res.json() as GithubRelease;
}

export async function fetchLatestReleaseFromHtmlRedirect(repo: string, request: ReleaseFetch = fetchWithTimeout) {
  const url = `https://github.com/${repo}/releases/latest`;
  const res = await request(url, { method: "HEAD", redirect: "manual", headers: { "User-Agent": "RikkaHub-PC" } });
  if (res.status < 300 || res.status >= 400) throw new Error("GitHub latest release did not redirect");
  const redirect = new URL(res.headers.get("location") ?? "", url);
  const prefix = `/${repo}/releases/tag/`;
  if (redirect.origin !== "https://github.com" || redirect.pathname.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase() || redirect.search || redirect.hash) {
    throw new Error("Invalid GitHub release redirect");
  }
  const tag = normalizeReleaseVersion(decodeURIComponent(redirect.pathname.slice(prefix.length)));
  return { tag, htmlUrl: redirect.href };
}

function metadataFromRelease(release: GithubRelease, repo: string, target: UpdateTarget): ReleaseMetadata {
  const latest = normalizeReleaseVersion(release.tag_name ?? "");
  const asset = pickReleaseAsset(release, target);
  const fileName = asset?.name ?? "";
  const digest = asset?.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  return {
    latest, title: release.name ?? release.tag_name ?? "", notes: release.body ?? "",
    htmlUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(release.tag_name ?? latest)}`,
    downloadUrl: fileName && target.platform === "win" && repo.toLowerCase() === DEFAULT_RELEASE_REPOSITORY.toLowerCase()
      ? `${UPDATE_R2_BASE}/${encodeURIComponent(fileName)}` : asset?.browser_download_url ?? "",
    fileName, size: asset?.size ?? 0, ...(digest ? { sha256: digest } : {}), source: "api",
  };
}

/** macOS only offers an asset confirmed by the release API, including its architecture. */
export async function discoverRelease(repo: string, target: UpdateTarget, current: string, request: ReleaseFetch = fetchWithTimeout): Promise<ReleaseMetadata> {
  parseReleaseRepository(repo);
  let redirect: Awaited<ReturnType<typeof fetchLatestReleaseFromHtmlRedirect>> | undefined;
  try { redirect = await fetchLatestReleaseFromHtmlRedirect(repo, request); } catch { /* API can still be available. */ }
  if (redirect && !isNewerRelease(redirect.tag, current)) {
    return { latest: redirect.tag, title: "", notes: "", htmlUrl: redirect.htmlUrl, downloadUrl: "", fileName: "", size: 0, source: "redirect" };
  }
  try { return metadataFromRelease(await fetchGithubLatestRelease(repo, request), repo, target); } catch (cause) {
    if (!redirect) throw new Error("检查更新失败：无法获取 GitHub 发布信息，请检查网络连接", { cause });
  }
  const fileName = target.containerized || target.platform === "mac" ? ""
    : target.platform === "linux" ? `Rikkahub_${redirect.tag}_linux_x64.tar.gz` : `Rikkahub_${redirect.tag}_x64-setup.exe`;
  return {
    latest: redirect.tag, title: `v${redirect.tag}`, notes: "", htmlUrl: redirect.htmlUrl,
    downloadUrl: !fileName ? "" : target.platform === "win" && repo.toLowerCase() === DEFAULT_RELEASE_REPOSITORY.toLowerCase()
      ? `${UPDATE_R2_BASE}/${encodeURIComponent(fileName)}`
      : `https://github.com/${repo}/releases/download/v${redirect.tag}/${encodeURIComponent(fileName)}`,
    fileName, size: 0, source: "redirect",
  };
}
