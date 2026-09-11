import { afterEach, describe, expect, test } from "bun:test";
import { downloadUpdatePackage, type UpdateDownloadProgress } from "~/services/update-download";

const realFetch = globalThis.fetch;
const request = { url: "https://github.com/owner/repo/releases/download/v2.1.0/Rikkahub_2.1.0_mac_arm64.dmg", fileName: "Rikkahub_2.1.0_mac_arm64.dmg", version: "2.1.0", size: 10, sha256: "a".repeat(64) };
const encoder = new TextEncoder();
const messages = { incompleteMessage: "incomplete", failedMessage: "failed" };
afterEach(() => { globalThis.fetch = realFetch; });

describe("update download stream lifecycle", () => {
  test("sends release identity and parses progress/completion across split chunks", async () => {
    let received: { input: unknown; options: RequestInit } | undefined;
    const controller = new AbortController();
    const progress: UpdateDownloadProgress[] = [];
    globalThis.fetch = (async (input: unknown, options: RequestInit) => {
      received = { input, options };
      return new Response(new ReadableStream({ start(stream) {
        for (const chunk of ["data: {\"type\":\"prog", "ress\",\"loaded\":5,\"total\":10,\"percent\":50}\n\ndata: {\"type\":\"done\",\"path\":\"/cache/中文.dmg\",\"size\":10}"])
          stream.enqueue(encoder.encode(chunk));
        stream.close();
      } }));
    }) as typeof fetch;
    await expect(downloadUpdatePackage(request, { ...messages, signal: controller.signal, onProgress: (item) => progress.push(item) })).resolves.toEqual({ path: "/cache/中文.dmg", size: 10 });
    expect(received?.input).toBe("/api/update/download");
    expect(received?.options.signal).toBe(controller.signal);
    expect(JSON.parse(String(received?.options.body))).toEqual(request);
    expect(progress).toEqual([{ loaded: 5, total: 10, percent: 50 }]);
  });

  test("cancellation releases the pending reader and never returns a completed path", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(encoder.encode('data: {"type":"progress","loaded":1}\n')); },
      cancel() { cancelled = true; },
    }))) as typeof fetch;
    const pending = downloadUpdatePackage(request, { ...messages, signal: controller.signal, onProgress: started });
    await ready;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  test("server errors cancel the stream; a new attempt can complete", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(encoder.encode('data: {"type":"error","message":"size mismatch"}\n')); },
      cancel() { cancelled = true; },
    }))) as typeof fetch;
    const options = () => ({ ...messages, signal: new AbortController().signal, onProgress: () => {} });
    await expect(downloadUpdatePackage(request, options())).rejects.toThrow("size mismatch");
    expect(cancelled).toBe(true);
    globalThis.fetch = (async () => new Response('data: {"type":"done","path":"/cache/retry.dmg","size":10}\n')) as typeof fetch;
    await expect(downloadUpdatePackage(request, options())).resolves.toEqual({ path: "/cache/retry.dmg", size: 10 });
  });

  test("incomplete streams, empty paths and pre-aborted calls are not successful downloads", async () => {
    const options = () => ({ ...messages, signal: new AbortController().signal, onProgress: () => {} });
    for (const body of ['data: {"type":"progress","loaded":10}\n', 'data: {"type":"done","path":""}\n']) {
      globalThis.fetch = (async () => new Response(body)) as typeof fetch;
      await expect(downloadUpdatePackage(request, options())).rejects.toThrow("incomplete");
    }
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response(""); }) as typeof fetch;
    const controller = new AbortController(); controller.abort();
    await expect(downloadUpdatePackage(request, { ...options(), signal: controller.signal })).rejects.toThrow();
    expect(called).toBe(false);
  });
});
