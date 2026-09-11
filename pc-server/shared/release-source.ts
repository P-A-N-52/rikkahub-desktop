export const DEFAULT_RELEASE_REPOSITORY = "P-A-N-52/rikkahub-desktop";

// The legacy Windows mirror belongs to upstream, independent of this fork's default.
export const UPSTREAM_RELEASE_REPOSITORY = "yuh-G/rikkahub-desktop";

/** An explicit GitHub owner/repository, never a URL, local path, or Git ref. */
export function parseReleaseRepository(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(value)
    || value.endsWith(".git")) {
    throw new Error("Release repository must be a GitHub owner/repository (without URL or .git)");
  }
  return value;
}
