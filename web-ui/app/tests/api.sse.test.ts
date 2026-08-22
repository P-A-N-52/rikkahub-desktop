import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sse } from "~/services/api";

/** sse() 内建重连（N-8）行为测试：打桩 globalThis.fetch 模拟服务端流。
 *  Bun 环境下 new Request("/api/…") 相对 URL 会抛错（无 document base），
 *  这里包一层 Request 把相对路径解析到 http://localhost。 */

const RealRequest = globalThis.Request;
const realFetch = globalThis.fetch;

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  globalThis.Request = class extends RealRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === "string" && input.startsWith("/")) {
        input = `http://localhost${input}`;
      }
      super(input, init);
    }
  } as typeof Request;
});

afterEach(() => {
  globalThis.Request = RealRequest;
  globalThis.fetch = realFetch;
});

describe("sse reconnect", () => {
  test("服务端关闭流后自动重连，重连连接上的消息照常送达", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return sseResponse(['event: update\ndata: {"n":1}\n\n']);
      return sseResponse(['event: update\ndata: {"n":2}\n\n']);
    }) as typeof fetch;

    const abort = new AbortController();
    const messages: number[] = [];
    let opens = 0;
    let closes = 0;

    const done = sse<{ n: number }>(
      "events",
      {
        onMessage: ({ data }) => {
          messages.push(data.n);
          if (data.n === 2) abort.abort();
        },
        onOpen: () => {
          opens += 1;
        },
        onClose: () => {
          closes += 1;
        },
      },
      { signal: abort.signal },
    );

    await done;
    expect(messages).toEqual([1, 2]);
    expect(calls).toBe(2);
    expect(opens).toBe(2);
    expect(closes).toBe(1);
  }, 10000);

  test("404 属不可自愈错误：不重连，onError/onClose 各一次", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "not found", code: 404 }), { status: 404 });
    }) as typeof fetch;

    const errors: Error[] = [];
    let closes = 0;
    await sse("conversations/gone/stream", {
      onMessage: () => {},
      onError: (error) => errors.push(error),
      onClose: () => {
        closes += 1;
      },
    });

    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { code?: number }).code).toBe(404);
    expect(closes).toBe(1);
  });

  test("退避等待期间 abort 会立即终止订阅，不再发起新连接", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return sseResponse([]);
    }) as typeof fetch;

    const abort = new AbortController();
    const done = sse("events", { onMessage: () => {} }, { signal: abort.signal });
    // 首连立即被服务端关闭（空流）→ 进入 1s 退避；50ms 后 abort 应立刻返回
    await new Promise((resolve) => setTimeout(resolve, 50));
    abort.abort();
    const start = Date.now();
    await done;
    expect(Date.now() - start).toBeLessThan(500);
    expect(calls).toBe(1);
  });

  test("reconnect:false 时保持旧语义：流结束即返回", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return sseResponse(['data: {"n":1}\n\n']);
    }) as typeof fetch;

    const messages: unknown[] = [];
    await sse("one-shot", { onMessage: ({ data }) => messages.push(data) }, { reconnect: false });
    expect(calls).toBe(1);
    expect(messages).toEqual([{ n: 1 }]);
  });
});
