import * as React from "react";

import { ArrowUp, File, FileDown, Image, LoaderCircle, Mic, Plus, Scissors, Sparkles, Square, TriangleAlert, Undo2, Video, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { ModelList } from "~/components/input/model-list";
import { SearchPickerButton } from "~/components/input/search-picker";
import { MemoryBadge } from "~/components/memory/memory-badge";
import { ExtensionPickerButton } from "~/components/input/extension-picker";
import { WorkspacePermissionPicker } from "~/components/input/workspace-permission-picker";
import { WorkspaceFilesButton } from "~/components/input/workspace-files-button";
import { useChatInputStore, useSettingsStore } from "~/stores";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Textarea } from "~/components/ui/textarea";
import { resolveFileUrl } from "~/lib/files";
import { DOCUMENT_UPLOAD_ACCEPT, uploadFilesToDraft } from "~/lib/upload";
import { cn } from "~/lib/utils";
import api, { appendWebAuthQuery } from "~/services/api";
import type { ExtractionStatusDto, UIMessagePart } from "~/types";

export interface ChatInputProps {
  value: string;
  attachments: UIMessagePart[];
  suggestions?: string[];
  ready?: boolean;
  disabled?: boolean;
  isGenerating?: boolean;
  isEditing?: boolean;
  onValueChange: (value: string) => void;
  onAddParts: (parts: UIMessagePart[]) => void;
  shouldDeleteFileOnRemove?: (part: UIMessagePart) => boolean;
  onRemovePart: (index: number, part: UIMessagePart) => Promise<void> | void;
  onSend: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onCancelEdit?: () => void;
  onSuggestionClick?: (suggestion: string) => void;
  onExportConversation?: (includeReasoning: boolean) => void;
  onCompressConversation?: () => void;
  /** 产品决策①:安卓"清除上下文"对齐(切换语义,再点一次撤销)。 */
  // 提示词优化时,返回最近几轮对话的纯文本作为上下文(让优化模型理解模糊指代)。
  // 无对话(首条消息)时返回空串。只在用户点击"优化提示词"时调用。
  getOptimizeContext?: () => string;
  className?: string;
}

const IMAGE_UPLOAD_ACCEPT = "image/*";

const ASR_FRAME_SIZE = 4096;

function websocketApiUrl(path: string) {
  const base =
    typeof window === "undefined"
      ? "ws://localhost:8080"
      : window.location.origin.replace(/^http/i, "ws");
  // WebSocket 无法携带 Authorization header，启用 web 鉴权时 token 走 access_token query
  return `${base}${appendWebAuthQuery(`/api/${path.replace(/^\/+/, "")}`)}`;
}

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function floatToPcm16(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function partLabel(part: UIMessagePart, t: (key: string) => string): string {
  switch (part.type) {
    case "document":
      return part.fileName;
    case "image":
      return t("chat.attachment_image");
    case "video":
      return t("chat.attachment_video");
    case "audio":
      return t("chat.attachment_audio");
    default:
      return t("chat.attachment_file");
  }
}

function partIcon(part: UIMessagePart) {
  switch (part.type) {
    case "image":
      return <Image className="size-3.5" />;
    case "video":
      return <Video className="size-3.5" />;
    case "audio":
      return <Mic className="size-3.5" />;
    case "document":
      return <File className="size-3.5" />;
    default:
      return <File className="size-3.5" />;
  }
}

function getPartFileId(part: UIMessagePart): number | null {
  const value = part.metadata?.fileId;
  return typeof value === "number" ? value : null;
}

// 专题4:PC 端"长文本粘贴转文件"固定开启、阈值 5000 字(用户决策)。刻意不读
// displaySetting.pasteLongTextAsFile/pasteLongTextThreshold——那是安卓端的设置,
// 会随备份导入被安卓的值覆盖(安卓默认关);PC 行为不受安卓备份影响。两个字段
// 仍照常存储并随备份透传,安卓端自用。
const PASTE_LONG_TEXT_THRESHOLD = 5000;

/** 专题4:确定性进度圆圈。percent=null 转不定圈(准备阶段/无逐页进度的格式),
 *  有值时按百分比画弧——成熟应用的"小圆圈一段一段加载到闭合"。 */
function ProgressRing({ percent }: { percent: number | null }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  if (percent == null) {
    return (
      <svg className="size-3.5 shrink-0 animate-spin text-primary" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${circumference * 0.3} ${circumference}`}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <svg className="size-3.5 shrink-0 -rotate-90 text-primary" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 专题4:附件的后台提取状态轮询。上传即时返回后,服务端在子进程里提取全文,
 *  这里每 600ms 轮询 files/:id/extraction 直到终态(done/empty/failed/none)。 */
function useExtractionStatus(fileId: number | null, isDocument: boolean): ExtractionStatusDto | null {
  const [status, setStatus] = React.useState<ExtractionStatusDto | null>(null);
  React.useEffect(() => {
    if (fileId == null || !isDocument) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await api.get<ExtractionStatusDto>(`files/${fileId}/extraction`);
        if (cancelled) return;
        setStatus(next);
        if (next.status === "pending") timer = setTimeout(poll, 600);
      } catch {
        // 文件已删/网络抖动:停止轮询,chip 恢复普通样式即可,发送走既有降级
        if (!cancelled) setStatus(null);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fileId, isDocument]);
  return status;
}

/** 专题4:附件 chip 上的提取指示。解析中 = 进度圆圈(PDF 有逐页百分比,其他格式
 *  不定圈);失败/无文本 = 可悬停的警示角标;done/none = 不渲染,chip 恢复普通样子。
 *  发送永远不被提取阻塞——未完成时该文件走 fallback 占位文案(服务端 3-4 机制)。 */
function ExtractionBadge({ part }: { part: UIMessagePart }) {
  const { t } = useTranslation("input");
  const fileId = getPartFileId(part);
  const status = useExtractionStatus(fileId, part.type === "document");
  if (!status) return null;
  if (status.status === "pending") {
    const hasPageProgress = status.done != null && status.total != null && status.total > 0;
    const percent = hasPageProgress ? Math.round((status.done! / status.total!) * 100) : null;
    const title = hasPageProgress
      ? t("chat.parsing_progress", { done: status.done, total: status.total })
      : t("chat.parsing");
    return (
      <span className="inline-flex items-center" title={title}>
        <ProgressRing percent={percent} />
      </span>
    );
  }
  if (status.status === "failed" || status.status === "empty") {
    const title = t(status.status === "failed" ? "chat.extraction_failed" : "chat.extraction_empty");
    return (
      <span className="inline-flex items-center text-amber-500" title={title}>
        <TriangleAlert className="size-3.5 shrink-0" />
      </span>
    );
  }
  return null;
}

function ChatInputInner({
  value,
  attachments,
  suggestions = [],
  ready = true,
  disabled = false,
  isGenerating = false,
  isEditing = false,
  onValueChange,
  onAddParts,
  shouldDeleteFileOnRemove,
  onRemovePart,
  onSend,
  onStop,
  onCancelEdit,
  onSuggestionClick,
  onExportConversation,
  onCompressConversation,
  getOptimizeContext,
  className,
}: ChatInputProps) {
  const { t } = useTranslation("input");
  const sendOnEnter = useSettingsStore(
    (state) => state.settings?.displaySetting.sendOnEnter ?? true,
  );
  const { currentAssistant, settings } = useCurrentAssistant();

  const quickMessages = React.useMemo(() => {
    const ids = currentAssistant?.quickMessageIds;
    const allQuickMessages = settings?.quickMessages ?? [];
    if (!Array.isArray(ids) || ids.length === 0 || allQuickMessages.length === 0) {
      return [] as QuickMessageOption[];
    }
    const idSet = new Set(ids);
    return allQuickMessages
      .filter((qm) => idSet.has(qm.id))
      .map((qm) => ({
        title: qm.title.trim() || t("chat.quick_message_default_title"),
        content: qm.content.trim(),
      }))
      .filter((item): item is QuickMessageOption => item.content.length > 0);
  }, [currentAssistant?.quickMessageIds, settings?.quickMessages, t]);

  const imageInputRef = React.useRef<HTMLInputElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  // ── 输入框高度拖拽 ──────────────────────────────────────────────────
  // 用户可上下拖动输入框上沿调整高度（左右不拖），高度持久化到 displaySetting，
  // 切换会话 / 重启后保留。拖拽过程中只改本地 dragHeight（流畅），松手才提交一次，
  // 避免 POST 风暴；store 由 SSE 推回更新，无需手动同步。
  const chatInputHeight = useSettingsStore(
    (state) => state.settings?.displaySetting.chatInputHeight ?? null,
  );
  const [dragHeight, setDragHeight] = React.useState<number | null>(null);
  const dragStartRef = React.useRef<{ startY: number; startHeight: number } | null>(null);
  // 拖拽中用 dragHeight，否则用持久化值；都为 null 时回退默认 60。
  const effectiveHeight = dragHeight ?? chatInputHeight;
  const inputMinHeight = effectiveHeight ?? 60;
  const inputMaxHeight = Math.max(
    inputMinHeight,
    typeof window !== "undefined" ? window.innerHeight * 0.7 : 600,
  );
  const onResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startHeight = effectiveHeight ?? 60;
    dragStartRef.current = { startY: event.clientY, startHeight };
    setDragHeight(startHeight);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    // 向下拖（dy > 0）→ 高度减小；向上拖（dy < 0）→ 高度增大。
    const next = start.startHeight - (event.clientY - start.startY);
    const min = 60;
    const max = typeof window !== "undefined" ? window.innerHeight * 0.7 : 600;
    setDragHeight(Math.round(Math.min(Math.max(next, min), max)));
  };
  const onResizePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    const finalHeight = dragHeight;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (finalHeight != null && finalHeight !== chatInputHeight) {
      void api
        .post("settings/display", { chatInputHeight: finalHeight })
        .catch((err) => console.warn("[chat-input] save height failed", err));
    }
  };

  const [submitting, setSubmitting] = React.useState(false);
  const uploading = useChatInputStore((state) => state.uploading);
  const uploadProgress = useChatInputStore((state) => state.uploadProgress);
  const [uploadMenuOpen, setUploadMenuOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [asrListening, setAsrListening] = React.useState(false);
  const asrSocketRef = React.useRef<WebSocket | null>(null);
  const asrAudioContextRef = React.useRef<AudioContext | null>(null);
  const asrSourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null);
  const asrProcessorRef = React.useRef<ScriptProcessorNode | null>(null);
  const asrStreamRef = React.useRef<MediaStream | null>(null);
  const asrFrameRef = React.useRef<Int16Array[]>([]);
  const asrFrameSamplesRef = React.useRef(0);
  // 提示词优化:点击后把输入框原文发给"提示词优化模型",返回的优化版直接替换输入框。
  // 优化成功后在优化按钮旁显示常驻"撤销"按钮(不走 toast —— toast 几秒就消失,用户来不及点
  // 或事后想反悔就没机会了)。originalBeforeOptimize 保存原文,点撤销即恢复;重新优化 / 发送
  // 消息时清空。optimizeHint:超过 8s 还在转时以小字内嵌在优化按钮旁显示"模型响应较慢"
  // (原方案放页面底部会把整个输入区往下挤,破坏布局)。
  const [optimizing, setOptimizing] = React.useState(false);
  const [optimizeHint, setOptimizeHint] = React.useState<string | null>(null);
  const [originalBeforeOptimize, setOriginalBeforeOptimize] = React.useState<string | null>(null);

  const isEmpty = value.trim().length === 0 && attachments.length === 0;

  const canStop = ready && Boolean(onStop) && isGenerating && !disabled;
  const canSend = ready && !isGenerating && !disabled && !isEmpty;
  // 生成中允许上传:用户常在模型输出时准备下一轮的 prompt 和附件,加文件到草稿和打字
  // 一样都不打断当前生成。submitting(发送的一瞬间)和 uploading 仍保留互斥。
  const canUpload = ready && !disabled && !uploading && !submitting;
  const canSwitchModel = ready && !disabled && !isGenerating && !uploading && !submitting;
  const canUseQuickMessage = ready && !disabled && !uploading && !submitting;
  const canUseAsr = ready && !disabled && !isGenerating && !uploading && !submitting;
  const actionDisabled = submitting || uploading || (!canStop && !canSend);

  const releaseAsrResources = React.useCallback(() => {
    asrProcessorRef.current?.disconnect();
    asrProcessorRef.current = null;
    asrSourceRef.current?.disconnect();
    asrSourceRef.current = null;
    void asrAudioContextRef.current?.close().catch(() => undefined);
    asrAudioContextRef.current = null;
    asrStreamRef.current?.getTracks().forEach((track) => track.stop());
    asrStreamRef.current = null;
    asrFrameRef.current = [];
    asrFrameSamplesRef.current = 0;
  }, []);

  React.useEffect(() => {
    if (!canUpload) {
      setUploadMenuOpen(false);
    }
  }, [canUpload]);

  const handlePrimaryAction = React.useCallback(async () => {
    if (actionDisabled) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (canStop) {
        await onStop?.();
        return;
      }

      if (canSend) {
        setOriginalBeforeOptimize(null);
        await onSend();
      }
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : t("chat.send_failed");
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }, [actionDisabled, canSend, canStop, onSend, onStop, t]);

  const handleOptimize = React.useCallback(async () => {
    const original = value.trim();
    if (!original || optimizing) return;
    setOptimizing(true);
    setOptimizeHint(null);
    // 8s 后还在转 → 显示"模型响应较慢",给用户感知(不然一直转圈不知道是卡死还是在想)。
    // 完成或出错时在 finally 里清掉。配合下方的 60s 超时,保证不会无限转。
    const slowTimer = setTimeout(() => setOptimizeHint(t("optimize.slow_hint")), 8_000);
    try {
      const context = getOptimizeContext?.() ?? "";
      const res = await api.post<{ text: string }>(
        "prompt/optimize",
        { text: value, context },
        { timeout: 60_000 },
      );
      const optimized = String(res.text ?? "").trim();
      if (!optimized) {
        toast.error(t("optimize.empty_result"));
        return;
      }
      onValueChange(optimized);
      setOriginalBeforeOptimize(original);
      toast.success(t("optimize.success"));
    } catch (err) {
      // 区分超时和其他错误,给更可操作的提示。AbortError/TimeoutError 是 ky 超时抛的。
      const isTimeout =
        err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      toast.error(
        isTimeout
          ? t("optimize.timeout")
          : err instanceof Error
            ? err.message
            : t("optimize.failed"),
      );
    } finally {
      clearTimeout(slowTimer);
      setOptimizeHint(null);
      setOptimizing(false);
    }
  }, [value, optimizing, onValueChange, getOptimizeContext]);

  const handleTextChange = React.useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      onValueChange(event.target.value);
      if (error) {
        setError(null);
      }
      // 用户开始编辑后,撤销入口就不再有意义(原文已和当前内容脱节)——收起撤销按钮。
      if (originalBeforeOptimize !== null) {
        setOriginalBeforeOptimize(null);
      }
    },
    [error, onValueChange, originalBeforeOptimize],
  );

  const handleQuickMessageSelect = React.useCallback(
    (content: string) => {
      if (!canUseQuickMessage || !content) {
        return;
      }

      const needLineBreak = value.length > 0 && !value.endsWith("\n");
      onValueChange(`${value}${needLineBreak ? "\n" : ""}${content}`);
      if (error) {
        setError(null);
      }
      textareaRef.current?.focus();
    },
    [canUseQuickMessage, error, onValueChange, value],
  );

  const stopAsr = React.useCallback(() => {
    asrSocketRef.current?.send(JSON.stringify({ type: "stop" }));
    asrSocketRef.current?.close(1000, "stop");
    asrSocketRef.current = null;
    releaseAsrResources();
    setAsrListening(false);
  }, [releaseAsrResources]);

  React.useEffect(() => () => stopAsr(), [stopAsr]);

  const toggleAsr = React.useCallback(async () => {
    if (!canUseAsr) return;
    if (asrListening) {
      stopAsr();
      return;
    }

    if (!settings?.selectedASRProviderId) {
      toast.error(t("asr.not_configured"));
      return;
    }

    try {
      const provider = settings.asrProviders?.find(
        (item) => item.id === settings.selectedASRProviderId,
      );
      if (!provider) {
        toast.error(t("asr.not_configured"));
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const socket = new WebSocket(websocketApiUrl("asr/realtime"));
      socket.binaryType = "arraybuffer";
      asrSocketRef.current = socket;
      asrStreamRef.current = stream;
      const baseText = value;
      let latestTranscript = "";
      const applyTranscript = (transcript: string) => {
        latestTranscript = transcript.trim();
        if (!latestTranscript) return;
        const prefix =
          baseText.trim().length > 0 && !baseText.endsWith("\n") ? `${baseText}\n` : baseText;
        onValueChange(`${prefix}${latestTranscript}`.trimStart());
        if (error) setError(null);
      };
      socket.onopen = async () => {
        socket.send(JSON.stringify({ type: "start", providerId: provider.id }));
        const AudioContextCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        const audioContext = new AudioContextCtor();
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        asrAudioContextRef.current = audioContext;
        asrSourceRef.current = source;
        asrProcessorRef.current = processor;
        const targetSampleRate = Math.max(
          8000,
          Number(provider.sampleRate || (provider.type === "openai_realtime" ? 24000 : 16000)),
        );
        processor.onaudioprocess = (event) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const channel = event.inputBuffer.getChannelData(0);
          const pcmBuffer = floatToPcm16(
            resampleLinear(channel, audioContext.sampleRate, targetSampleRate),
          );
          const chunk = new Int16Array(pcmBuffer);
          asrFrameRef.current.push(chunk);
          asrFrameSamplesRef.current += chunk.length;
          while (asrFrameSamplesRef.current >= ASR_FRAME_SIZE) {
            const frame = new Int16Array(ASR_FRAME_SIZE);
            let offset = 0;
            while (offset < ASR_FRAME_SIZE) {
              const head = asrFrameRef.current[0];
              const take = Math.min(head.length, ASR_FRAME_SIZE - offset);
              frame.set(head.subarray(0, take), offset);
              offset += take;
              if (take === head.length) {
                asrFrameRef.current.shift();
              } else {
                asrFrameRef.current[0] = head.subarray(take);
              }
              asrFrameSamplesRef.current -= take;
            }
            socket.send(frame.buffer);
          }
        };
        source.connect(processor);
        processor.connect(audioContext.destination);
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const payload = JSON.parse(event.data) as {
          type?: string;
          transcript?: string;
          error?: string;
        };
        if (payload.type === "transcript") applyTranscript(payload.transcript ?? "");
        if (payload.type === "error") {
          const message = payload.error || t("asr.failed");
          setError(message);
          toast.error(message);
          stopAsr();
        }
      };
      socket.onerror = () => {
        toast.error(t("asr.connect_failed"));
        stopAsr();
      };
      socket.onclose = () => {
        releaseAsrResources();
        asrSocketRef.current = null;
        setAsrListening(false);
      };
      setAsrListening(true);
    } catch (asrError) {
      const message = asrError instanceof Error ? asrError.message : t("asr.mic_denied");
      setError(message);
      toast.error(message);
      stopAsr();
    }
  }, [
    asrListening,
    canUseAsr,
    error,
    onValueChange,
    releaseAsrResources,
    settings,
    stopAsr,
    value,
  ]);

  const handleSuggestionSelect = React.useCallback(
    (suggestion: string) => {
      if (!canUseQuickMessage || !suggestion) {
        return;
      }

      onSuggestionClick?.(suggestion);
      if (error) {
        setError(null);
      }
      textareaRef.current?.focus();
    },
    [canUseQuickMessage, error, onSuggestionClick],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      if (isGenerating) return;
      if (event.nativeEvent.isComposing) return;

      // 镜像逻辑：
      // sendOnEnter = true: Enter 发送，Shift+Enter 换行
      // sendOnEnter = false: Shift+Enter 发送，Enter 换行
      const shouldSend = sendOnEnter ? !event.shiftKey : event.shiftKey;
      if (!shouldSend) return;

      event.preventDefault();
      void handlePrimaryAction();
    },
    [handlePrimaryAction, isGenerating, sendOnEnter],
  );

  const handleUploadInputChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      // React 的 currentTarget 只在同步分发阶段有值,await 恢复后为 null;先同步抓住
      // input 元素再清空 value(不清空则同一文件二次选择不触发 change)。
      const input = event.currentTarget;
      const result = await uploadFilesToDraft(input.files, onAddParts);
      if (result.error) setError(result.error);
      input.value = "";
    },
    [onAddParts],
  );

  const handlePaste = React.useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!canUpload) return;

      // 粘贴长文本自动转换为文件(专题4:PC 端固定开启,阈值 5000 字,见常量注释)
      {
        const text = event.clipboardData.getData("text/plain");
        if (text.length > PASTE_LONG_TEXT_THRESHOLD) {
          event.preventDefault();
          const file = new globalThis.File([text], "pasted_text.txt", {
            type: "text/plain",
          });
          toast.info(t("chat.long_text_as_file"));
          const result = await uploadFilesToDraft([file], onAddParts);
          if (result.error) setError(result.error);
          return;
        }
      }

      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is globalThis.File => file !== null);

      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      const result = await uploadFilesToDraft(files, onAddParts);
      if (result.error) setError(result.error);
    },
    [canUpload, onAddParts, t],
  );

  const sendHint = sendOnEnter ? t("chat.send_hint_enter") : t("chat.send_hint_newline");
  const placeholder = ready ? t("chat.placeholder_ready") : t("chat.placeholder_not_ready");

  return (
    <div className={className}>
      <div className="mx-auto w-full max-w-3xl px-4 py-4">
        {/* 可拖拽的上沿手柄：上下拖改变输入框高度（左右锁定）。对标微信等桌面聊天
            应用，让用户按需放大/收起输入区，尺寸跨会话与重启保留。 */}
        <div
          className="flex h-3 cursor-ns-resize touch-none items-center justify-center"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("resize_handle")}
        >
          <div className="h-1 w-10 rounded-full bg-border/70 transition-colors hover:bg-primary/50" />
        </div>
        <div className="chat-input-box relative flex flex-col gap-2 rounded-[var(--ds-chat-composer-radius)] bg-[var(--ds-surface-input)] p-3">
          {/* 待确认记忆提醒角标:浮在输入框右上角外沿,像消息提醒。仅有待确认项时渲染。 */}
          <div className="absolute -top-4 right-2 z-10">
            <MemoryBadge />
          </div>
          {isEditing ? (
            <div className="flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
              <span className="text-primary">{t("chat.editing_tip")}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={onCancelEdit}
                disabled={submitting || uploading}
              >
                {t("chat.cancel_edit")}
              </Button>
            </div>
          ) : null}

          {uploading ? (
            <div className="flex flex-wrap gap-2 px-2 pt-1">
              <div className="inline-flex items-center gap-1.5 rounded-full border bg-background/80 px-2 py-1 text-xs text-muted-foreground">
                <ProgressRing percent={uploadProgress} />
                <span>{t("chat.uploading_progress", { percent: uploadProgress ?? 0 })}</span>
              </div>
            </div>
          ) : null}

          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-2 pt-1">
              {attachments.map((part, index) => {
                const key = `${part.type}-${index}`;
                return (
                  <div
                    key={key}
                    className="group inline-flex max-w-[220px] items-center gap-1 rounded-full border bg-background/80 px-2 py-1 text-xs"
                  >
                    {part.type === "image" ? (
                      <img
                        alt="upload"
                        className="size-5 rounded object-cover"
                        src={resolveFileUrl(part.url)}
                      />
                    ) : (
                      partIcon(part)
                    )}
                    <span className="truncate">{partLabel(part, t)}</span>
                    <ExtractionBadge part={part} />
                    <button
                      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={async () => {
                        if (!ready || disabled || isGenerating || submitting) return;

                        const fileId = getPartFileId(part);
                        if (fileId != null && (shouldDeleteFileOnRemove?.(part) ?? true)) {
                          try {
                            await api.delete<{ status: string }>(`files/${fileId}`);
                          } catch (deleteError) {
                            const message =
                              deleteError instanceof Error
                                ? deleteError.message
                                : t("chat.delete_attachment_failed");
                            setError(message);
                            return;
                          }
                        }

                        await onRemovePart(index, part);
                      }}
                      type="button"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={(event) => {
              void handlePaste(event);
            }}
            placeholder={placeholder}
            disabled={!ready || disabled}
            className="resize-none border-0 bg-transparent dark:bg-transparent p-2 text-sm shadow-none hover:shadow-none focus-visible:shadow-none focus-visible:ring-0"
            rows={2}
            style={{ minHeight: `${inputMinHeight}px`, maxHeight: `${inputMaxHeight}px` }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <DropdownMenu open={uploadMenuOpen} onOpenChange={setUploadMenuOpen}>
                <input
                  ref={fileInputRef}
                  accept={DOCUMENT_UPLOAD_ACCEPT}
                  className="hidden"
                  multiple
                  onChange={handleUploadInputChange}
                  type="file"
                />
                <input
                  ref={imageInputRef}
                  accept={IMAGE_UPLOAD_ACCEPT}
                  className="hidden"
                  multiple
                  onChange={handleUploadInputChange}
                  type="file"
                />
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={!canUpload}
                    className="toolbar-btn size-8 rounded-full text-[var(--ds-icon)] hover:text-foreground"
                  >
                    <Plus
                      className={cn("size-4 transition-transform", uploadMenuOpen && "rotate-45")}
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-36" side="top" align="start">
                  <DropdownMenuItem
                    onClick={() => {
                      imageInputRef.current?.click();
                    }}
                  >
                    <Image className="size-4" />
                    {t("chat.upload_image")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      fileInputRef.current?.click();
                    }}
                  >
                    <File className="size-4" />
                    {t("chat.upload_document")}
                  </DropdownMenuItem>
                  {onExportConversation && (
                    <DropdownMenuItem
                      onClick={() => {
                        onExportConversation(false);
                      }}
                    >
                      <FileDown className="size-4" />
                      {t("chat.export_conversation")}
                    </DropdownMenuItem>
                  )}
                  {onExportConversation && (
                    <DropdownMenuItem
                      onClick={() => {
                        onExportConversation(true);
                      }}
                    >
                      <FileDown className="size-4" />
                      {t("chat.export_conversation_with_reasoning")}
                    </DropdownMenuItem>
                  )}
                  {onCompressConversation && (
                    <DropdownMenuItem
                      onClick={() => {
                        onCompressConversation();
                      }}
                    >
                      <Scissors className="size-4" />
                      {t("compress_history")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <QuickMessageButton
                quickMessages={quickMessages}
                disabled={!canUseQuickMessage}
                onSelect={handleQuickMessageSelect}
              />
              <SearchPickerButton disabled={!canSwitchModel} />
              <ExtensionPickerButton disabled={!canSwitchModel} />
              <WorkspaceFilesButton />
              <WorkspacePermissionPicker />
            </div>
            <div className="relative flex items-center gap-1.5">
              {/* 优化较慢提示:浮在按钮组上方,绝对定位不挤占布局(原方案放底部会把整个输入区往下顶)。 */}
              {optimizeHint ? (
                <span className="animate-pulse absolute -top-8 right-0 z-10 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[0.6875rem] text-muted-foreground shadow-sm">
                  {optimizeHint}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={isEmpty || optimizing || isGenerating || disabled}
                onClick={() => {
                  void handleOptimize();
                }}
                className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                title={t("optimize.title")}
              >
                {optimizing ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
              </Button>
              {originalBeforeOptimize !== null ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                  title={t("optimize.undo_title")}
                  onClick={() => {
                    onValueChange(originalBeforeOptimize);
                    setOriginalBeforeOptimize(null);
                  }}
                >
                  <Undo2 className="size-3.5" />
                  {t("optimize.undo")}
                </Button>
              ) : null}
              <ModelList disabled={!canSwitchModel} className="max-w-56" />
              {/* NewMax cpd-action-btn:语音/发送合一——空文本=麦克风(常驻底色),有文本=
                  品牌色上箭头,录音=红底声纹条,生成中=红底停止。状态切换带宽度/配色过渡。 */}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={
                  isGenerating || !isEmpty ? actionDisabled : !canUseAsr && !asrListening
                }
                title={
                  isGenerating
                    ? t("chat.stop_generating")
                    : asrListening
                      ? t("asr.stop")
                      : isEmpty
                        ? t("asr.start")
                        : undefined
                }
                onClick={() => {
                  if (isGenerating || !isEmpty) void handlePrimaryAction();
                  else toggleAsr();
                }}
                className={cn(
                  "cpd-action-btn size-8 rounded-full",
                  isGenerating
                    ? "cpd-action-btn--send !bg-destructive !text-white"
                    : asrListening
                      ? "cpd-action-btn--recording"
                      : isEmpty
                        ? "cpd-action-btn--idle toolbar-btn text-[var(--ds-icon)] hover:text-foreground"
                        : "cpd-action-btn--send",
                )}
              >
                {submitting || uploading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : isGenerating ? (
                  <span className="cpd-icon-enter" key="stop">
                    <Square className="size-4" />
                  </span>
                ) : asrListening ? (
                  <span className="cpd-voice-bars" key="bars">
                    <span />
                    <span />
                    <span />
                  </span>
                ) : isEmpty ? (
                  <span className="cpd-icon-enter" key="mic">
                    <Mic className="size-4" />
                  </span>
                ) : (
                  <span className="cpd-icon-enter" key="send">
                    <ArrowUp className="size-4" />
                  </span>
                )}
              </Button>
            </div>
          </div>
        </div>
        {/* 建议问题 chips:置于输入卡下方(NewMax 形态),pill-bg 胶囊 + 品牌色 */}
        {suggestions.length > 0 ? (
          <div className="flex gap-1.5 overflow-x-auto px-1 pt-2">
            {suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion}-${index}`}
                type="button"
                disabled={!canUseQuickMessage}
                className="inline-flex h-6 shrink-0 items-center rounded-full bg-[var(--ds-pill-bg)] px-2.5 text-[12px] font-medium text-[var(--ds-brand-primary)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  handleSuggestionSelect(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        <p className="mt-2 text-center text-xs text-muted-foreground">{sendHint}</p>
        {error ? <p className="mt-1 text-center text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

export const ChatInput = React.memo(ChatInputInner);
ChatInput.displayName = "ChatInput";

type QuickMessageOption = {
  title: string;
  content: string;
};

interface QuickMessageButtonProps {
  quickMessages: QuickMessageOption[];
  disabled?: boolean;
  onSelect: (content: string) => void;
}

function QuickMessageButton({
  quickMessages,
  disabled = false,
  onSelect,
}: QuickMessageButtonProps) {
  if (quickMessages.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          className="toolbar-btn size-8 rounded-full text-[var(--ds-icon)] hover:text-foreground"
        >
          <Zap className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" side="top" align="start">
        {quickMessages.map((quickMessage, index) => {
          const key = `${quickMessage.title}-${index}`;
          return (
            <DropdownMenuItem
              key={key}
              className="items-start"
              onClick={() => {
                onSelect(quickMessage.content);
              }}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{quickMessage.title}</div>
                <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                  {quickMessage.content}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
