// Bun preload used only by the public, unauthenticated Pi model generator.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./build-provenance";

const output = process.env.RIKKAHUB_MODEL_SOURCE_DIR;
if (!output) throw new Error("Model fetch recorder requires RIKKAHUB_MODEL_SOURCE_DIR");
const allowed = new Set([
  "https://models.dev/api.json",
  "https://openrouter.ai/api/v1/models",
  "https://ai-gateway.vercel.sh/v1/models",
  "https://integrate.api.nvidia.com/v1/models",
]);
const records: { url: string; fetchedAt: string; status: number; bytes: number; sha256: string; file: string }[] = [];
const fetchPublic = globalThis.fetch;
mkdirSync(output, { recursive: true });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (!allowed.has(request.url) || request.method !== "GET" || [...request.headers].length > 0) {
    throw new Error("Model provenance permits only the pinned generator's public unauthenticated GET sources");
  }
  const response = await fetchPublic(request, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("Public model source exceeds 32 MiB");
  const digest = sha256(bytes);
  const file = `${digest}.json`;
  writeFileSync(join(output, file), bytes);
  records.push({ url: request.url, fetchedAt: new Date().toISOString(), status: response.status, bytes: bytes.byteLength, sha256: digest, file });
  return new Response(bytes, { status: response.status, headers: response.headers });
}) as typeof fetch;
process.on("beforeExit", () => writeFileSync(join(output, "sources.json"), `${JSON.stringify(records, null, 2)}\n`));
