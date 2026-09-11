import assert from "node:assert/strict";
import test from "node:test";
import { initialRuntimeStatus } from "./runtime-types.ts";
import {
  isSupportedRuntimePlatform,
  nextRuntimeStatus,
  redactRuntimeDiagnostics,
} from "./runtime-policy.ts";

test("runtime platform policy supports desktop hosts", () => {
  assert.equal(isSupportedRuntimePlatform("darwin"), true);
  assert.equal(isSupportedRuntimePlatform("linux"), true);
  assert.equal(isSupportedRuntimePlatform("win32"), true);
});

test("runtime progress is clamped and readiness is preserved", () => {
  const status = nextRuntimeStatus(
    initialRuntimeStatus(),
    "starting-backend",
    "starting backend",
    120,
    { memoryReady: true }
  );
  assert.equal(status.progress, 100);
  assert.equal(status.memoryReady, true);
  assert.equal(status.backendReady, false);
});

test("runtime diagnostics redact generated and provider API keys", () => {
  assert.equal(
    redactRuntimeDiagnostics("api key     sm_abcdefghijklmnopqrstuvwxyz123456"),
    "api key     [REDACTED]",
  );
  assert.equal(
    redactRuntimeDiagnostics("provider failed with sk-abcdefghijklmnopqrstuvwxyz"),
    "provider failed with [REDACTED]",
  );
});
