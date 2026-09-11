import type { RuntimePhase, RuntimeStatus } from "./runtime-types.js";

export function isSupportedRuntimePlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

export function redactRuntimeDiagnostics(message: string): string {
  return message
    .replace(/\b(sm_[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(
      /(api[\s_-]*key\s*(?::|=|\s)\s*)(\S+)/gi,
      "$1[REDACTED]",
    );
}

export function nextRuntimeStatus(
  current: RuntimeStatus,
  phase: RuntimePhase,
  message: string,
  progress: number,
  patch: Partial<RuntimeStatus> = {}
): RuntimeStatus {
  return {
    ...current,
    ...patch,
    phase,
    message,
    progress: Math.max(0, Math.min(100, progress)),
    updatedAt: new Date().toISOString(),
  };
}
