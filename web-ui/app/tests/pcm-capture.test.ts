import { describe, expect, test } from "bun:test";
import { createPcmCapture } from "../lib/pcm-capture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeNode {
  connections: unknown[] = [];
  disconnects = 0;
  connect(destination: unknown) { this.connections.push(destination); }
  disconnect() { this.disconnects++; }
}

function fixture(inputRate = 16000) {
  const events: string[] = [];
  const resumed = deferred<void>();
  const media = deferred<MediaStream>();
  const track = { stops: 0, stop() { this.stops++; } };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const source = new FakeNode();
  const processor = Object.assign(new FakeNode(), { onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null });
  const mute = Object.assign(new FakeNode(), { gain: { value: 1 } });
  const destination = {};
  const context = {
    sampleRate: inputRate,
    state: "suspended",
    closeCalls: 0,
    resume() { events.push("resume"); return resumed.promise; },
    close() { this.closeCalls++; this.state = "closed"; return Promise.resolve(); },
    createMediaStreamSource(value: MediaStream) { expect(value).toBe(stream); events.push("source"); return source; },
    createScriptProcessor(size: number, inputs: number, outputs: number) {
      expect([size, inputs, outputs]).toEqual([4096, 1, 1]);
      return processor;
    },
    createGain() { return mute; },
    destination,
  };
  const environment = {
    createContext() { events.push("context"); return context as unknown as AudioContext; },
    getUserMedia(constraints: MediaStreamConstraints) {
      events.push("getUserMedia");
      expect(constraints.audio).toEqual({ channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      return media.promise;
    },
  };
  const emit = (data: Float32Array) => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } } as unknown as AudioProcessingEvent);
  return { events, resumed, media, track, stream, source, processor, mute, destination, context, environment, emit };
}

describe("PCM microphone capture lifecycle", () => {
  test("creates and resumes AudioContext synchronously from the user action, then waits for both prerequisites", async () => {
    const f = fixture();
    const capture = createPcmCapture({ sampleRate: 16000, onFrame() {} }, f.environment);
    expect(f.events).toEqual(["context", "resume", "getUserMedia"]);
    f.media.resolve(f.stream);
    await Promise.resolve();
    expect(f.events).not.toContain("source");
    f.resumed.resolve();
    await capture.ready;
    expect(f.source.connections).toEqual([f.processor]);
    expect(f.processor.connections).toEqual([f.mute]);
    expect(f.mute.connections).toEqual([f.destination]);
    expect(f.mute.gain.value).toBe(0);
    capture.stop();
  });

  test("cancel during permission prompt closes the context and stops every late microphone track", async () => {
    const f = fixture();
    const capture = createPcmCapture({ sampleRate: 16000, onFrame() {} }, f.environment);
    const ready = capture.ready.catch((error) => error.name);
    capture.stop();
    capture.stop();
    expect(f.context.closeCalls).toBe(1);
    f.resumed.resolve();
    f.media.resolve(f.stream);
    expect(await ready).toBe("AbortError");
    expect(f.track.stops).toBe(1);
    expect(f.events).not.toContain("source");
  });

  test("resume rejection cleans immediately and still owns a stream acquired later", async () => {
    const f = fixture();
    const capture = createPcmCapture({ sampleRate: 16000, onFrame() {} }, f.environment);
    const ready = capture.ready.catch((error) => error.message);
    f.resumed.reject(new Error("resume denied"));
    expect(await ready).toBe("resume denied");
    expect(f.context.closeCalls).toBe(1);
    f.media.resolve(f.stream);
    await Promise.resolve();
    expect(f.track.stops).toBe(1);
    expect(f.events).not.toContain("source");
  });

  test("permission rejection closes the context while resume is pending", async () => {
    const f = fixture();
    const capture = createPcmCapture({ sampleRate: 16000, onFrame() {} }, f.environment);
    const ready = capture.ready.catch((error) => error.name);
    f.media.reject(new DOMException("Permission denied", "NotAllowedError"));
    expect(await ready).toBe("NotAllowedError");
    expect(f.context.closeCalls).toBe(1);
    f.resumed.resolve();
  });

  test("synchronous microphone failure observes a pending resume rejection and closes the context", async () => {
    const f = fixture();
    expect(() => createPcmCapture({ sampleRate: 16000, onFrame() {} }, {
      ...f.environment,
      getUserMedia() { throw new Error("getUserMedia unavailable"); },
    })).toThrow("getUserMedia unavailable");
    f.resumed.reject(new Error("resume later rejected"));
    await Promise.resolve();
    expect(f.context.closeCalls).toBe(1);
  });

  test("graph setup failure releases the stream and the context", async () => {
    const f = fixture();
    f.context.createMediaStreamSource = () => { throw new Error("source unavailable"); };
    const capture = createPcmCapture({ sampleRate: 16000, onFrame() {} }, f.environment);
    const ready = capture.ready.catch((error) => error.message);
    f.resumed.resolve(); f.media.resolve(f.stream);
    expect(await ready).toBe("source unavailable");
    expect(f.track.stops).toBe(1);
    expect(f.context.closeCalls).toBe(1);
  });

  test("emits complete 4096-sample PCM16 little-endian frames across callbacks without microphone playback", async () => {
    const f = fixture();
    const frames: ArrayBuffer[] = [];
    const capture = createPcmCapture({ sampleRate: 16000, onFrame: frame => frames.push(frame) }, f.environment);
    f.resumed.resolve(); f.media.resolve(f.stream);
    await capture.ready;
    const first = new Float32Array(2048);
    first.set([-1, 1, 0.5, -0.5, 2, -2]);
    f.emit(first);
    expect(frames).toHaveLength(0);
    f.emit(new Float32Array(2048).fill(0.25));
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(8192);
    expect(Array.from(new Uint8Array(frames[0], 0, 12))).toEqual([0, 128, 255, 127, 255, 63, 0, 192, 255, 127, 0, 128]);
    expect(new DataView(frames[0]).getInt16(4096, true)).toBe(8191);
    const lateCallback = f.processor.onaudioprocess!;
    capture.stop(); capture.stop();
    expect(f.track.stops).toBe(1);
    expect(f.context.closeCalls).toBe(1);
    expect([f.source.disconnects, f.processor.disconnects, f.mute.disconnects]).toEqual([1, 1, 1]);
    expect(f.processor.onaudioprocess).toBeNull();
    lateCallback({ inputBuffer: { getChannelData: () => new Float32Array(4096) } } as unknown as AudioProcessingEvent);
    expect(frames).toHaveLength(1);
  });

  test("resamples the capture rate to the provider rate before framing", async () => {
    const f = fixture(48000);
    const frames: ArrayBuffer[] = [];
    const capture = createPcmCapture({ sampleRate: 16000, onFrame: frame => frames.push(frame) }, f.environment);
    f.resumed.resolve(); f.media.resolve(f.stream);
    await capture.ready;
    const input = new Float32Array(12288).fill(0.25);
    input[3] = 0.5;
    f.emit(input);
    expect(frames).toHaveLength(1);
    const view = new DataView(frames[0]);
    expect(view.getInt16(0, true)).toBe(8191);
    expect(view.getInt16(2, true)).toBe(16383);
    capture.stop();
  });

  test("a stop from the frame consumer prevents additional frames in the same callback", async () => {
    const f = fixture();
    const frames: ArrayBuffer[] = [];
    const capture = createPcmCapture({ sampleRate: 16000, onFrame: frame => { frames.push(frame); capture.stop(); } }, f.environment);
    f.resumed.resolve(); f.media.resolve(f.stream);
    await capture.ready;
    f.emit(new Float32Array(8192));
    expect(frames).toHaveLength(1);
    expect(f.track.stops).toBe(1);
  });
});
