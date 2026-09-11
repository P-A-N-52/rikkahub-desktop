import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";

import { FontPicker } from "~/components/font-picker";
import { FONT_CATALOG_QUERY_KEY, useFontCatalog } from "~/hooks/use-font-catalog";
import settingsTranslations from "~/locales/en-US/settings.json";
import type { FontEntry } from "~/types/font";

const RealRequest = globalThis.Request;
const realFetch = globalThis.fetch;
const clients: QueryClient[] = [];
const font = (name: string, source: FontEntry["source"]): FontEntry => ({
  id: `${source}:${name}`, label: name, cssName: name, family: `"${name}", sans-serif`, source, weights: [],
});
const builtin = font("Bundled Face", "builtin");
const custom = font("Uploaded Face", "custom");
const native = font("Native Face", "system");
const basicResponse = { builtin: [builtin], custom: [custom], system: [] };

beforeEach(() => {
  globalThis.Request = class extends RealRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" && input.startsWith("/") ? `http://localhost${input}` : input, init);
    }
  } as typeof Request;
});

afterEach(() => {
  globalThis.Request = RealRequest;
  globalThis.fetch = realFetch;
  clients.splice(0).forEach((client) => client.clear());
});

function clientAndRead() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  function read() {
    let value!: ReturnType<typeof useFontCatalog>;
    function Probe() { value = useFontCatalog(); return null; }
    renderToStaticMarkup(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    return value;
  }
  read(); // Creates the real hook's query functions/options without browser effects.
  const basicQuery = client.getQueryCache().find({ queryKey: [...FONT_CATALOG_QUERY_KEY, "basic"] })!;
  const systemQuery = client.getQueryCache().find({ queryKey: [...FONT_CATALOG_QUERY_KEY, "system"] })!;
  return { client, read, basicQuery, systemQuery };
}

describe("font catalog loading", () => {
  test("slow native enumeration does not block bundled/custom data, then merges without duplicate families", async () => {
    let resolveNative!: (response: Response) => void;
    const nativeResponse = new Promise<Response>((resolve) => { resolveNative = resolve; });
    globalThis.fetch = (async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/fonts/list" && url.searchParams.get("system") === "0") return Response.json(basicResponse);
      if (url.pathname === "/api/fonts/system") return nativeResponse;
      throw new Error(`Unexpected font endpoint: ${url.pathname}`);
    }) as typeof fetch;
    const { client, read, basicQuery, systemQuery } = clientAndRead();
    const pending = systemQuery.fetch();
    await basicQuery.fetch();
    expect(read().data).toEqual(basicResponse);
    expect(read().isLoading).toBe(false);
    expect(read().isSystemLoading).toBe(true);

    resolveNative(Response.json({ system: [native, font("BUNDLED FACE", "system"), font("Uploaded Face", "system")] }));
    await pending;
    expect(read().data).toEqual({ ...basicResponse, system: [native] });
    expect(read().isSystemLoading).toBe(false);

    await client.invalidateQueries({ queryKey: FONT_CATALOG_QUERY_KEY, refetchType: "none" });
    expect(basicQuery.state.isInvalidated).toBe(true);
    expect(systemQuery.state.isInvalidated).toBe(true);
  });

  test("native failure remains an error, keeps bundled data and retries only on request", async () => {
    let systemCalls = 0;
    globalThis.fetch = (async (request: Request) => {
      if (new URL(request.url).pathname === "/api/fonts/list") return Response.json(basicResponse);
      systemCalls++;
      return systemCalls === 1
        ? Response.json({ error: "Native font query failed", code: 500 }, { status: 500 })
        : Response.json({ system: [native] });
    }) as typeof fetch;
    const { client, read, basicQuery, systemQuery } = clientAndRead();
    await basicQuery.fetch();
    await expect(systemQuery.fetch()).rejects.toThrow("Native font query failed");
    expect(systemCalls).toBe(1); // Includes the HTTP client's retry policy.
    expect(systemQuery.state.status).toBe("error");
    expect(read().data).toEqual(basicResponse);
    expect(read().isLoading).toBe(false);
    expect(read().systemError?.message).toBe("Native font query failed");

    // Opening another picker must not silently rerun a costly failed native query.
    const observer = new QueryObserver(client, systemQuery.options);
    const unsubscribe = observer.subscribe(() => {});
    try {
      await Bun.sleep(5);
      expect(systemCalls).toBe(1);
      await read().refetchSystem();
      expect(systemCalls).toBe(2);
      expect(read().data?.system).toEqual([native]);
      expect(read().systemError).toBeNull();
    } finally { unsubscribe(); }
  });

  test("saved native font keeps its name and preview while its catalog entry is unavailable", async () => {
    const { client } = clientAndRead();
    client.setQueryData([...FONT_CATALOG_QUERY_KEY, "basic"], basicResponse);
    const i18n = createInstance();
    await i18n.init({ lng: "en-US", resources: { "en-US": { settings: settingsTranslations } }, interpolation: { escapeValue: false } });
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <FontPicker label="UI font" value="system:Saved Native Face" fallbackFamily="sans-serif" onChange={() => { throw new Error("Loading must not change the saved selection"); }} />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    expect(html).toContain("Saved Native Face");
    expect(html).not.toContain("System default");
    expect(html).toContain("font-family:&quot;Saved Native Face&quot;, sans-serif");
  });
});
