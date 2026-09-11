import {
  ASSEMBLYAI_API_KEY,
  ASSEMBLYAI_DICTATION_URL,
  DICTATION_LANGUAGES,
  DICTATION_MAX_SECONDS,
} from "../config.js";

/**
 * AssemblyAI Dictation client.
 *
 * One HTTP call takes a short clip (WAV or raw 16-bit PCM, at most 120 s) and
 * returns the verbatim transcript together with an LLM-tidied rewrite. The
 * body is multipart with `config` first and `audio` second — the server starts
 * transcribing as bytes arrive and rejects requests where audio precedes
 * config. Authentication is the raw API key, no `Bearer` prefix.
 */

export interface DictationRequest {
  /** Raw little-endian 16-bit PCM samples. */
  pcm: Buffer;
  sampleRate: number;
  channels?: number;
  /** Context for the speech model, e.g. "A user asking their assistant a question." */
  sttPrompt?: string;
  /** Names / jargon to bias the transcription toward. */
  keyterms?: string[];
  /** Plain-English description of the rewrite. Omit for default disfluency cleanup. */
  llmInstruction?: string;
  languageCodes?: string[];
}

export interface DictationResult {
  /** Verbatim transcript, never altered by the LLM. */
  text: string;
  /** Cleaned-up rewrite; falls back to `text` when the rewrite failed. */
  cleaned: string;
  confidence: number;
  durationMs: number;
  sessionId: string | null;
  rewriteError: string | null;
}

export class DictationError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "DictationError";
    this.status = status;
    this.code = code;
  }
}

export function isDictationConfigured(): boolean {
  return ASSEMBLYAI_API_KEY.trim().length > 0;
}

export function dictationStatus(): { enabled: boolean; provider: string; max_seconds: number } {
  return {
    enabled: isDictationConfigured(),
    provider: "assemblyai-dictation",
    max_seconds: DICTATION_MAX_SECONDS,
  };
}

const REQUEST_TIMEOUT_MS = 90_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

interface DictationPayload {
  text?: string;
  llm_response?: string | null;
  llm_error?: string | null;
  confidence?: number;
  audio_duration_ms?: number;
  session_id?: string;
}

interface DictationErrorPayload {
  error?: string;
  error_code?: string;
  detail?: string;
  title?: string;
}

function describeError(status: number, payload: DictationErrorPayload | null): string {
  if (status === 404) {
    // The service reports a bad key as 404, not 401.
    return "AssemblyAI rejected the API key. Check ASSEMBLYAI_API_KEY.";
  }
  if (status === 401) return "No AssemblyAI credential was supplied.";
  if (status === 413) return "The clip is too long — keep dictation under two minutes.";
  if (status === 415) return "AssemblyAI only accepts WAV or raw PCM audio.";
  if (status === 429) return "AssemblyAI is rate limiting dictation. Try again in a moment.";
  if (status === 503) return "AssemblyAI is at capacity. Try again in a moment.";
  return (
    payload?.error ??
    payload?.detail ??
    payload?.title ??
    `AssemblyAI dictation failed (${status})`
  );
}

async function postOnce(form: FormData): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(ASSEMBLYAI_DICTATION_URL, {
      method: "POST",
      headers: { Authorization: ASSEMBLYAI_API_KEY },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeDictation(
  request: DictationRequest
): Promise<DictationResult> {
  if (!isDictationConfigured()) {
    throw new DictationError(
      "ASSEMBLYAI_API_KEY is not set. Add it in Settings or the project .env file.",
      503,
      "not_configured"
    );
  }

  const channels = request.channels ?? 1;
  const bytesPerSecond = request.sampleRate * channels * 2;
  const seconds = request.pcm.byteLength / bytesPerSecond;
  if (request.pcm.byteLength < bytesPerSecond * 0.2) {
    throw new DictationError("The recording was too short to transcribe.", 400, "too_short");
  }
  if (seconds > DICTATION_MAX_SECONDS) {
    throw new DictationError(
      `Dictation clips are limited to ${DICTATION_MAX_SECONDS} seconds.`,
      413,
      "audio_too_large"
    );
  }

  const config: Record<string, unknown> = {
    sample_rate: request.sampleRate,
    channels,
    language_codes:
      request.languageCodes && request.languageCodes.length > 0
        ? request.languageCodes
        : DICTATION_LANGUAGES,
  };
  if (request.sttPrompt) config.stt_prompt = request.sttPrompt.slice(0, 4096);
  if (request.keyterms && request.keyterms.length > 0) {
    config.keyterms_prompt = request.keyterms.slice(0, 50);
  }
  if (request.llmInstruction) config.llm_instruction = request.llmInstruction.slice(0, 2048);

  const buildForm = () => {
    const form = new FormData();
    // `config` must be the first part.
    form.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }));
    form.append(
      "audio",
      new Blob([new Uint8Array(request.pcm)], { type: "audio/pcm" }),
      "dictation.pcm"
    );
    return form;
  };

  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await postOnce(buildForm());
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    } catch (err) {
      lastError = err;
      if (attempt === 1) break;
    }
  }

  if (!response) {
    const message =
      lastError instanceof Error && lastError.name === "AbortError"
        ? "AssemblyAI dictation timed out."
        : `AssemblyAI dictation is unreachable: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`;
    throw new DictationError(message, 502, "unreachable");
  }

  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorPayload = (payload ?? {}) as DictationErrorPayload;
    throw new DictationError(
      describeError(response.status, errorPayload),
      response.status,
      errorPayload.error_code ?? null
    );
  }

  const body = (payload ?? {}) as DictationPayload;
  const text = (body.text ?? "").trim();
  const cleaned = (body.llm_response ?? "").trim() || text;

  return {
    text,
    cleaned,
    confidence: typeof body.confidence === "number" ? body.confidence : 0,
    durationMs:
      typeof body.audio_duration_ms === "number"
        ? body.audio_duration_ms
        : Math.round(seconds * 1000),
    sessionId: typeof body.session_id === "string" ? body.session_id : null,
    rewriteError: body.llm_error ?? null,
  };
}
