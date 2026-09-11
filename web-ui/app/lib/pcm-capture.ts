const FRAME_SAMPLES = 4096;

export interface PcmCapture {
  ready: Promise<void>;
  stop(): void;
}

interface CaptureEnvironment {
  createContext(): AudioContext;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

function browserEnvironment(): CaptureEnvironment {
  const AudioContextCtor = window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor || !navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("Microphone capture is unavailable in this environment", "NotSupportedError");
  }
  return {
    createContext: () => new AudioContextCtor(),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  };
}

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let i = 0; i < output.length; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

/** Call directly from the user's click: Safari needs resume before the first await. */
export function createPcmCapture(
  { sampleRate, onFrame }: { sampleRate: number; onFrame(frame: ArrayBuffer): void },
  environment: CaptureEnvironment = browserEnvironment(),
): PcmCapture {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("Invalid microphone sample rate");
  const context = environment.createContext();
  let stopped = false;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let mute: GainNode | undefined;
  let frame = new ArrayBuffer(FRAME_SAMPLES * 2);
  let samples = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (processor) processor.onaudioprocess = null;
    processor?.disconnect();
    source?.disconnect();
    mute?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    samples = 0;
    if (context.state !== "closed") {
      void context.close().catch((error) => console.warn("[asr] AudioContext close failed", error));
    }
  };

  let resumed: Promise<void> | undefined;
  try {
    resumed = context.resume();
    const acquired = environment.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).then((acquiredStream) => {
      if (stopped) {
        acquiredStream.getTracks().forEach((track) => track.stop());
        throw new DOMException("Microphone capture cancelled", "AbortError");
      }
      stream = acquiredStream;
      return acquiredStream;
    });
    const ready = Promise.all([resumed, acquired]).then(([, acquiredStream]) => {
      if (stopped) throw new DOMException("Microphone capture cancelled", "AbortError");
      source = context.createMediaStreamSource(acquiredStream);
      processor = context.createScriptProcessor(FRAME_SAMPLES, 1, 1);
      mute = context.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (stopped) return;
        const channel = resampleLinear(event.inputBuffer.getChannelData(0), context.sampleRate, sampleRate);
        let view = new DataView(frame);
        for (const input of channel) {
          const value = Math.max(-1, Math.min(1, input));
          view.setInt16(samples * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
          samples++;
          if (samples === FRAME_SAMPLES) {
            onFrame(frame);
            frame = new ArrayBuffer(FRAME_SAMPLES * 2);
            view = new DataView(frame);
            samples = 0;
            if (stopped) return;
          }
        }
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
    }).catch((error) => {
      stop();
      throw error;
    });
    return { ready, stop };
  } catch (error) {
    // getUserMedia can throw synchronously after resume has already returned a promise.
    void resumed?.catch(() => undefined);
    stop();
    throw error;
  }
}
