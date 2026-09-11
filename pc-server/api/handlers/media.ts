// api/handlers/media.ts — 媒体路由（settings/asr-provider/*、settings/tts-provider/*、tts/*、asr/*、images/*）
// 纪律：纯搬迁自 server.ts routeApi()；TTS/ASR provider 契约冻结。

import type { AsrProvider, TtsProvider } from "../../foundation/types";
import { saveState, state } from "../../persistence/json-store";
import { friendlyRequestError } from "../../foundation/net";
import { cancelAllSystemTts } from "../../tools/platform";
import { callImageGeneration } from "../../media/image-gen";
import { defaultAsrProvider, normalizeAsrProviders, transcribeAudioWithAsrProvider } from "../../media/asr";
import { DEFAULT_SYSTEM_TTS_ID, defaultTtsProvider, generateSpeechWithTtsProvider, normalizeTtsProviders } from "../../media/tts";
import { error, json, readJson } from "../request";
import { updateSettings } from "../../app-config";

export async function handleMediaRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "settings/asr-provider/detail" && request.method === "POST") {
    const body = await readJson<Partial<AsrProvider>>(request);
    const type = ["dashscope", "volcengine", "openai_realtime"].includes(String(body.type))
      ? String(body.type) as AsrProvider["type"]
      : "openai_realtime";
    const base = defaultAsrProvider(type);
    const providerItem = normalizeAsrProviders([{ ...base, ...body, type, id: String(body.id ?? base.id) }])[0];
    const exists = state.settings.asrProviders.some((item) => item.id === providerItem.id);
    updateSettings({
      ...state.settings,
      asrProviders: exists
        ? state.settings.asrProviders.map((item) => item.id === providerItem.id ? providerItem : item)
        : [providerItem, ...state.settings.asrProviders],
      selectedASRProviderId: state.settings.selectedASRProviderId ?? providerItem.id,
    });
    return json({ status: "ok", provider: providerItem });
  }
  if (path === "settings/asr-provider/select" && request.method === "POST") {
    const body = await readJson<{ id: string }>(request);
    const providerId = String(body.id ?? "");
    if (!state.settings.asrProviders.some((provider) => provider.id === providerId)) return error("ASR provider not found", 404);
    updateSettings({ ...state.settings, selectedASRProviderId: providerId });
    return json({ status: "ok" });
  }
  const asrProviderDelete = path.match(/^settings\/asr-provider\/([^/]+)$/);
  if (asrProviderDelete && request.method === "DELETE") {
    const providerId = decodeURIComponent(asrProviderDelete[1]);
    const asrProviders = state.settings.asrProviders.filter((provider) => provider.id !== providerId);
    updateSettings({
      ...state.settings,
      asrProviders,
      selectedASRProviderId: state.settings.selectedASRProviderId === providerId ? asrProviders[0]?.id ?? null : state.settings.selectedASRProviderId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/asr-provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.asrProviders.map((provider) => [provider.id, provider]));
    const reordered = (body.ids ?? []).map((providerId) => byId.get(providerId)).filter(Boolean) as AsrProvider[];
    for (const provider of state.settings.asrProviders) {
      if (!reordered.some((item) => item.id === provider.id)) reordered.push(provider);
    }
    updateSettings({ ...state.settings, asrProviders: reordered });
    return json({ status: "ok" });
  }

  if (path === "settings/tts-provider/detail" && request.method === "POST") {
    const body = await readJson<Partial<TtsProvider>>(request);
    const type = ["system", "openai", "gemini", "minimax", "qwen", "groq", "xai", "mimo"].includes(String(body.type)) ? body.type as TtsProvider["type"] : "system";
    const base = defaultTtsProvider(type);
    const providerItem = normalizeTtsProviders([{ ...base, ...body, type, id: String(body.id ?? base.id) }])[0];
    const exists = state.settings.ttsProviders.some((item) => item.id === providerItem.id);
    updateSettings({
      ...state.settings,
      ttsProviders: exists
        ? state.settings.ttsProviders.map((item) => item.id === providerItem.id ? providerItem : item)
        : [providerItem, ...state.settings.ttsProviders],
      selectedTTSProviderId: state.settings.selectedTTSProviderId ?? providerItem.id,
    });
    return json({ status: "ok", provider: providerItem });
  }
  if (path === "settings/tts-provider/select" && request.method === "POST") {
    const body = await readJson<{ id: string }>(request);
    const providerId = String(body.id ?? "");
    if (!state.settings.ttsProviders.some((provider) => provider.id === providerId)) return error("TTS provider not found", 404);
    updateSettings({ ...state.settings, selectedTTSProviderId: providerId });
    return json({ status: "ok" });
  }
  const ttsProviderDelete = path.match(/^settings\/tts-provider\/([^/]+)$/);
  if (ttsProviderDelete && request.method === "DELETE") {
    const providerId = decodeURIComponent(ttsProviderDelete[1]);
    if (providerId === DEFAULT_SYSTEM_TTS_ID) return error("System TTS provider cannot be deleted", 400);
    const ttsProviders = state.settings.ttsProviders.filter((provider) => provider.id !== providerId);
    updateSettings({
      ...state.settings,
      ttsProviders,
      selectedTTSProviderId: state.settings.selectedTTSProviderId === providerId ? ttsProviders[0]?.id ?? null : state.settings.selectedTTSProviderId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/tts-provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.ttsProviders.map((provider) => [provider.id, provider]));
    const reordered = (body.ids ?? []).map((providerId) => byId.get(providerId)).filter(Boolean) as TtsProvider[];
    for (const provider of state.settings.ttsProviders) {
      if (!reordered.some((item) => item.id === provider.id)) reordered.push(provider);
    }
    updateSettings({ ...state.settings, ttsProviders: reordered });
    return json({ status: "ok" });
  }

  // The play bar's stop button cancels active native speech and invalidates queued
  // system-TTS work. Online-TTS providers don't need cancellation server-side — they're already
  // synchronous request/response, and the client aborts its fetch directly.
  if (path === "tts/cancel" && request.method === "POST") {
    cancelAllSystemTts();
    return json({ status: "ok" });
  }
  if (path === "tts/speech" && request.method === "POST") {
    const body = await readJson<{ text?: string; providerId?: string; speed?: number }>(request);
    const text = String(body.text ?? "").trim();
    if (!text) return error("Text is required", 400);
    try {
      const result = await generateSpeechWithTtsProvider(text, body.providerId, body.speed);
      if (!result.audio) return error("TTS provider returned no audio", 502);
      return new Response(result.audio as BodyInit, {
        headers: {
          "Content-Type": result.mime,
          "Cache-Control": "no-store",
          "X-RikkaHub-TTS-Provider": result.provider.id,
        },
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }

  if (path === "asr/transcribe" && request.method === "POST") {
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) return error("No audio file uploaded", 400);
    try {
      const text = await transcribeAudioWithAsrProvider(file);
      return json({ status: "ok", text });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }

  if (path === "images" && request.method === "GET") {
    return json({ images: state.generatedImages });
  }
  if (path === "images/generate" && request.method === "POST") {
    const body = await readJson<{ prompt: string; numberOfImages?: number; aspectRatio?: string; referenceFileIds?: number[] }>(request);
    if (!String(body.prompt ?? "").trim()) return error("Prompt is required", 400);
    try {
      const images = await callImageGeneration({
        prompt: String(body.prompt).trim(),
        numberOfImages: Number(body.numberOfImages ?? 1),
        aspectRatio: String(body.aspectRatio ?? "square"),
        referenceFileIds: Array.isArray(body.referenceFileIds) ? body.referenceFileIds.map(Number).filter(Number.isFinite) : [],
        // 域10-2:客户端取消/断开即中止上游生成,不再空转到自然超时。
        signal: request.signal,
      });
      return json({ status: "ok", images });
    } catch (err) {
      // 客户端主动取消(AbortError)/断开:不算失败,回 499 与压缩中止同款口径,前端静默忽略。
      if (err instanceof DOMException && err.name === "AbortError") {
        return error("Client cancelled", 499);
      }
      return error(friendlyRequestError(err, state.settings.proxyConfig), 502);
    }
  }
  const generatedImageDelete = path.match(/^images\/([^/]+)$/);
  if (generatedImageDelete && request.method === "DELETE") {
    const imageId = decodeURIComponent(generatedImageDelete[1]);
    state.generatedImages = state.generatedImages.filter((image) => image.id !== imageId);
    saveState();
    return json({ status: "deleted" });
  }
  return null;
}
