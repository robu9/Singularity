import os from "os";
import path from "path";
import { loadRootEnv } from "./load-env.js";

loadRootEnv();

export const API_PORT = Number(process.env.SINGULARITY_PORT ?? 3030);
export const API_HOST = process.env.SINGULARITY_HOST ?? "127.0.0.1";

export const DATA_DIR =
  process.env.SINGULARITY_DATA_DIR ??
  path.join(os.homedir(), ".singularity");

export const DB_PATH = path.join(DATA_DIR, "db.sqlite");
export const FRAMES_DIR = path.join(DATA_DIR, "frames");
export const AUDIO_DIR = path.join(DATA_DIR, "audio");
export const VIDEO_DIR = path.join(DATA_DIR, "video");
export const TMP_DIR = path.join(DATA_DIR, "tmp");

/** Frames per MP4 chunk before rotating to a new file */
export const VIDEO_CHUNK_MAX_FRAMES = Number(
  process.env.SINGULARITY_VIDEO_CHUNK_FRAMES ?? 150
);

/**
 * Stored video is downscaled to this width (never upscaled). OCR runs on the
 * full-resolution capture before encoding, so search quality is unaffected.
 */
export const VIDEO_MAX_WIDTH = Number(
  process.env.SINGULARITY_VIDEO_MAX_WIDTH ?? 1920
);

/** Capture interval in ms — event-driven lite via frame dedup */
export const CAPTURE_INTERVAL_MS = Number(
  process.env.SINGULARITY_CAPTURE_INTERVAL ?? 2000
);

export const OCR_ENABLED = process.env.SINGULARITY_OCR !== "0";

/** OCR engine override: "native" (platform default), "tesseract", or "off" */
export const OCR_ENGINE = (process.env.SINGULARITY_OCR_ENGINE ?? "native") as
  | "native"
  | "tesseract"
  | "off";
export const AUDIO_ENABLED = process.env.SINGULARITY_AUDIO !== "0";

/**
 * Explicit microphone override, e.g. ":1" on macOS or a dshow device name on
 * Windows. Empty means auto-detect.
 */
export const AUDIO_INPUT_DEVICE =
  process.env.SINGULARITY_AUDIO_INPUT_DEVICE ?? "";
export const AUTO_START_CAPTURE = process.env.SINGULARITY_AUTO_START !== "0";

/** Audio chunk length in seconds before transcription */
export const AUDIO_CHUNK_SEC = Number(
  process.env.SINGULARITY_AUDIO_CHUNK_SEC ?? 30
);

export const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
export const GEMINI_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

/**
 * Fallback models tried in order when the primary is overloaded.
 *
 * Free-tier capacity pressure returns 503 "high demand" per model, and which
 * model is saturated rotates minute to minute — pinning a single "better" one
 * does not help. Each entry is only tried after the previous one exhausts its
 * retries, so a healthy primary costs nothing.
 */
export const GEMINI_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS ??
  "gemini-3.6-flash,gemini-flash-latest,gemini-2.5-flash"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * Transcription model. Split from GEMINI_MODEL so meeting audio can be tuned
 * without changing the chat/summary model (and vice versa).
 */
export const GEMINI_STT_MODEL = process.env.GEMINI_STT_MODEL ?? GEMINI_MODEL;

/**
 * AssemblyAI Dictation — push-to-talk voice input for the Assistant.
 * The renderer records a clip, the backend forwards it and returns the
 * transcript. Optional: without a key the microphone button is hidden.
 */
export const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY ?? "";
export const ASSEMBLYAI_DICTATION_URL =
  process.env.ASSEMBLYAI_DICTATION_URL ??
  "https://dictation.assemblyai.com/v1/transcribe/live";
/** ISO language codes the dictation model should expect, comma separated. */
export const DICTATION_LANGUAGES = (process.env.DICTATION_LANGUAGES ?? "en")
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean);
/** Hard cap enforced by the Dictation API; clips are cut before this. */
export const DICTATION_MAX_SECONDS = 120;
