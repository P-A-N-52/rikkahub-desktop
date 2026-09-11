import { appendWebAuthQuery } from "./api";

export interface UpdateDownloadRequest {
  url: string;
  fileName: string;
  version: string;
  size: number;
  sha256?: string;
}

export interface UpdateDownloadProgress { loaded: number; total: number; percent: number }

/** Owns the SSE reader for one download, including cancellation and incomplete streams. */
export async function downloadUpdatePackage(
  request: UpdateDownloadRequest,
  options: {
    signal: AbortSignal;
    onProgress: (progress: UpdateDownloadProgress) => void;
    incompleteMessage: string;
    failedMessage: string;
  },
): Promise<{ path: string; size: number }> {
  const { signal } = options;
  signal.throwIfAborted();
  const response = await fetch(appendWebAuthQuery("/api/update/download"), {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { path: string; size: number } | undefined;
  let complete = false;
  const line = (text: string) => {
    signal.throwIfAborted();
    if (!text.trim().startsWith("data: ")) return;
    let event: { type?: string; loaded?: number; total?: number; percent?: number; path?: string; size?: number; message?: string };
    try { event = JSON.parse(text.trim().slice(6)); } catch { return; }
    if (event.type === "progress") {
      options.onProgress({ loaded: Number(event.loaded) || 0, total: Number(event.total) || 0, percent: Number(event.percent) || 0 });
    } else if (event.type === "done" && event.path) {
      result = { path: String(event.path), size: Number(event.size) || 0 };
    } else if (event.type === "error") {
      throw new Error(String(event.message || options.failedMessage));
    }
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) line(text);
      if (done) break;
    }
    if (buffer.trim()) line(buffer);
    if (!result) throw new Error(options.incompleteMessage);
    complete = true;
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
