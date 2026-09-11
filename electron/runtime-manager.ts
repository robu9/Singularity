import { app, safeStorage, shell } from "electron";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import manifest from "../build/runtime-manifest.json";
import {
  initialRuntimeStatus,
  type RuntimeError,
  type RuntimePhase,
  type RuntimeStatus,
  type ModelProvider,
} from "./runtime-types.js";
import { startBackend, stopBackend } from "./backend-manager.js";
import {
  isSupportedRuntimePlatform,
  nextRuntimeStatus,
  redactRuntimeDiagnostics,
} from "./runtime-policy.js";

type StatusListener = (status: RuntimeStatus) => void;

interface StoredSecret {
  encrypted: boolean;
  content: string;
}

/**
 * Owns the lifecycle of the local runtime: the capture backend (which embeds
 * the memory graph) and the encrypted credentials handed to it. There is no
 * separate database process to install or supervise — memory lives inside
 * the backend's SQLite file.
 */
export class RuntimeManager {
  private status: RuntimeStatus = initialRuntimeStatus();
  private listeners = new Set<StatusListener>();
  private activeStart: Promise<void> | null = null;
  private existingLogSanitized = false;

  getStatus = (): RuntimeStatus => ({ ...this.status });

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  private update(
    phase: RuntimePhase,
    message: string,
    progress: number,
    patch: Partial<RuntimeStatus> = {}
  ) {
    this.status = nextRuntimeStatus(this.status, phase, message, progress, patch);
    this.writeLog(`${phase}: ${message}`);
    for (const listener of this.listeners) listener(this.getStatus());
  }

  private paths() {
    const root = path.join(app.getPath("userData"), "runtime");
    return {
      root,
      log: path.join(root, "runtime.log"),
      provider: path.join(root, "provider.json"),
      dictation: path.join(root, "dictation.json"),
    };
  }

  private writeLog(message: string) {
    try {
      const { root, log } = this.paths();
      mkdirSync(root, { recursive: true });
      if (!this.existingLogSanitized) {
        this.existingLogSanitized = true;
        if (existsSync(log)) {
          const existing = readFileSync(log, "utf8");
          const sanitized = redactRuntimeDiagnostics(existing);
          if (sanitized !== existing) writeFileSync(log, sanitized, { mode: 0o600 });
        }
      }
      appendFileSync(
        log,
        `[${new Date().toISOString()}] ${redactRuntimeDiagnostics(message)}\n`,
      );
      chmodSync(log, 0o600);
    } catch {
      // Logging must never prevent startup.
    }
  }

  async openLogs() {
    const { root, log } = this.paths();
    mkdirSync(root, { recursive: true });
    if (!existsSync(log)) appendFileSync(log, "Singularity runtime log\n");
    await shell.showItemInFolder(log);
  }

  // ------------------------------------------------------------ secrets

  private writeSecret(filePath: string, payload: unknown) {
    const serialized = JSON.stringify(payload);
    const encrypted = safeStorage.isEncryptionAvailable();
    const content = encrypted
      ? safeStorage.encryptString(serialized).toString("base64")
      : Buffer.from(serialized, "utf8").toString("base64");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const stored: StoredSecret = { encrypted, content };
    writeFileSync(filePath, JSON.stringify(stored), { mode: 0o600 });
    chmodSync(filePath, 0o600);
  }

  private readSecret<T>(filePath: string): T | null {
    if (!existsSync(filePath)) return null;
    try {
      const stored = JSON.parse(readFileSync(filePath, "utf8")) as StoredSecret;
      const buffer = Buffer.from(stored.content, "base64");
      const payload = stored.encrypted
        ? safeStorage.decryptString(buffer)
        : buffer.toString("utf8");
      return JSON.parse(payload) as T;
    } catch (error) {
      this.writeLog(`stored credential could not be read: ${String(error)}`);
      return null;
    }
  }

  getProviderInfo(): { provider: ModelProvider | null; configured: boolean } {
    if (process.env.GEMINI_API_KEY) {
      return { provider: "gemini", configured: true };
    }
    const value = this.readSecret<{ provider?: string; apiKey?: string }>(
      this.paths().provider
    );
    return value?.provider === "gemini" && value.apiKey?.trim()
      ? { provider: "gemini", configured: true }
      : { provider: null, configured: false };
  }

  configureProvider(provider: ModelProvider, apiKey: string) {
    const key = apiKey.trim();
    if (!key) throw new Error("API key is required");
    this.writeSecret(this.paths().provider, { provider, apiKey: key });
  }

  getDictationInfo(): { configured: boolean } {
    if (process.env.ASSEMBLYAI_API_KEY) return { configured: true };
    const value = this.readSecret<{ apiKey?: string }>(this.paths().dictation);
    return { configured: Boolean(value?.apiKey?.trim()) };
  }

  configureDictation(apiKey: string) {
    const key = apiKey.trim();
    if (!key) throw new Error("API key is required");
    this.writeSecret(this.paths().dictation, { apiKey: key });
  }

  private getSecretEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (!process.env.GEMINI_API_KEY) {
      const provider = this.readSecret<{ provider?: string; apiKey?: string }>(
        this.paths().provider
      );
      if (provider?.provider === "gemini" && provider.apiKey?.trim()) {
        env.GEMINI_API_KEY = provider.apiKey;
      }
    }
    if (!process.env.ASSEMBLYAI_API_KEY) {
      const dictation = this.readSecret<{ apiKey?: string }>(this.paths().dictation);
      if (dictation?.apiKey?.trim()) env.ASSEMBLYAI_API_KEY = dictation.apiKey;
    }
    return env;
  }

  // ---------------------------------------------------------- lifecycle

  start(): Promise<void> {
    if (this.activeStart) return this.activeStart;
    this.activeStart = this.startInternal().finally(() => {
      this.activeStart = null;
    });
    return this.activeStart;
  }

  async retry(): Promise<void> {
    await this.stop();
    this.status = initialRuntimeStatus();
    await this.start();
  }

  private async startInternal() {
    try {
      if (!app.isPackaged) {
        this.update("checking", "Waiting for development services", 20);
        this.update("starting-backend", "Connecting to the recorder", 60);
        await startBackend(this.getSecretEnv(), (message) =>
          this.writeLog(`backend: ${message}`)
        );
        this.update("ready", "Local runtime ready", 100, {
          memoryReady: true,
          backendReady: true,
          error: undefined,
        });
        return;
      }

      if (!isSupportedRuntimePlatform(process.platform)) {
        throw this.runtimeError(
          "UNSUPPORTED_PLATFORM",
          "Singularity requires Windows, macOS, or Linux.",
          false
        );
      }

      mkdirSync(this.paths().root, { recursive: true });
      this.update("checking", "Checking local runtime", 15);
      this.update("starting-backend", "Starting the Singularity recorder", 45);

      try {
        await startBackend(
          {
            SINGULARITY_NATIVE_DIR: path.join(process.resourcesPath, "backend-native"),
            SINGULARITY_AUTO_START: "0",
            ...this.getSecretEnv(),
          },
          (message) => this.writeLog(`backend: ${message}`)
        );
      } catch (error) {
        const inUse = String(error).includes("already in use");
        throw this.runtimeError(
          inUse ? "PORT_IN_USE" : "BACKEND_START_FAILED",
          inUse
            ? `Port ${manifest.backendPort} is already in use by another process.`
            : "The Singularity capture engine could not be started.",
          true,
          error instanceof Error ? error.stack : String(error)
        );
      }

      this.update("ready", "Singularity is ready", 100, {
        memoryReady: true,
        backendReady: true,
        error: undefined,
      });
    } catch (error) {
      const runtimeError = this.asRuntimeError(error);
      this.fail(runtimeError);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.update("stopping", "Stopping local services", 10, {
      backendReady: false,
    });
    stopBackend();
    this.update("stopping", "Local services stopped", 100, {
      memoryReady: false,
      backendReady: false,
    });
  }

  private runtimeError(
    code: RuntimeError["code"],
    message: string,
    retryable: boolean,
    detail?: string
  ): RuntimeError {
    return { code, message, retryable, detail };
  }

  private asRuntimeError(error: unknown): RuntimeError {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      "retryable" in error
    ) {
      return error as RuntimeError;
    }
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    const code = detail.includes("health check timed out") || detail.includes("failed to start")
      ? "HEALTH_TIMEOUT"
      : "UNKNOWN";
    return this.runtimeError(code, "The local runtime could not be started.", true, detail);
  }

  private fail(error: RuntimeError) {
    this.update("error", error.message, this.status.progress, {
      error,
      backendReady: false,
    });
  }
}
