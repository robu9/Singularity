import { api, type DictationResponse } from "@/lib/api/client";

/**
 * Push-to-talk dictation for the Assistant.
 *
 * The microphone is captured through the Web Audio API, downsampled to 16 kHz
 * mono 16-bit PCM in the renderer, and buffered until `stop()` is called. The
 * finished clip is posted to the backend, which forwards it to AssemblyAI
 * Dictation and returns the tidied transcript. Nothing streams to a third
 * party while the user is still speaking; only the completed clip leaves the
 * machine, and only through the local backend.
 */

export const DICTATION_SAMPLE_RATE = 16_000;
/** Cut a little before the API's 120 s ceiling so the upload always fits. */
export const DICTATION_MAX_SECONDS = 115;

export interface DictationHandlers {
  /** Audio level 0–1, roughly 10× per second, for a meter. */
  onLevel?: (level: number) => void;
  /** Seconds recorded so far, once a second. */
  onTick?: (seconds: number) => void;
  /** Fired when the recorder hits the time limit and stops itself. */
  onAutoStop?: () => void;
}

function downsample(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  // Average the source samples that fall into each output sample — cheap
  // anti-aliasing that is enough for speech.
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    out[i] = end > start ? sum / (end - start) : (input[start] ?? 0);
  }
  return out;
}

function toInt16(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export class DictationRecorder {
  private mediaStream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Int16Array[] = [];
  private samples = 0;
  private startedAt = 0;
  private tickTimer: number | null = null;
  private stopped = false;

  constructor(private readonly handlers: DictationHandlers = {}) {}

  get recording(): boolean {
    return this.ctx !== null && !this.stopped;
  }

  get seconds(): number {
    return this.samples / DICTATION_SAMPLE_RATE;
  }

  async start(): Promise<void> {
    if (this.ctx) throw new Error("dictation already recording");

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.mediaStream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (this.stopped || !this.ctx) return;
      const input = event.inputBuffer.getChannelData(0);

      let peak = 0;
      for (let i = 0; i < input.length; i += 8) {
        const v = Math.abs(input[i] ?? 0);
        if (v > peak) peak = v;
      }
      this.handlers.onLevel?.(Math.min(1, peak * 1.6));

      const pcm = toInt16(downsample(input, this.ctx.sampleRate, DICTATION_SAMPLE_RATE));
      this.chunks.push(pcm);
      this.samples += pcm.length;

      if (this.seconds >= DICTATION_MAX_SECONDS) {
        this.stopped = true;
        this.handlers.onAutoStop?.();
      }
    };

    source.connect(this.processor);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(this.ctx.destination);

    this.startedAt = Date.now();
    this.tickTimer = window.setInterval(() => {
      this.handlers.onTick?.(Math.floor((Date.now() - this.startedAt) / 1000));
    }, 1000);
  }

  /** Stop capturing and return the recorded clip as 16-bit PCM. */
  async stop(): Promise<{ pcm: ArrayBuffer; seconds: number }> {
    this.stopped = true;
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    try {
      this.processor?.disconnect();
    } catch {
      // ignore
    }
    this.processor = null;
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    if (this.ctx && this.ctx.state !== "closed") {
      await this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;

    const merged = new Int16Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    return { pcm: merged.buffer, seconds: this.samples / DICTATION_SAMPLE_RATE };
  }

  /** Discard the clip without transcribing. */
  async cancel(): Promise<void> {
    await this.stop();
  }
}

/** Record → transcribe convenience for callers that only need the text. */
export async function transcribeClip(pcm: ArrayBuffer): Promise<DictationResponse> {
  return api.dictate(pcm, DICTATION_SAMPLE_RATE);
}
