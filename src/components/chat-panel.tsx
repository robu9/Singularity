import React, { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Send, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { findMainSection } from "@/lib/nav";
import { Input } from "@/components/ui/input";
import { electron } from "@/lib/electron";
import { api } from "@/lib/api/client";
import {
  DICTATION_MAX_SECONDS,
  DictationRecorder,
  transcribeClip,
} from "@/lib/dictation";
import { cn } from "@/lib/utils";
import {
  useChatStore,
  simulateAssistantReply,
  type ChatMessage,
} from "@/lib/stores/chat-store";

function getSafeExternalUrl(href?: string): string | null {
  if (!href) return null;

  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => getSafeExternalUrl(url) ?? ""}
      components={{
        a: ({ href, children, ...props }) => {
          const safeUrl = getSafeExternalUrl(href);
          if (!safeUrl) return <span>{children}</span>;

          return (
            <a
              {...props}
              href={safeUrl}
              onClick={(event) => {
                event.preventDefault();
                if (electron?.openExternal) {
                  void electron.openExternal(safeUrl);
                } else {
                  window.open(safeUrl, "_blank", "noopener,noreferrer");
                }
              }}
            >
              {children}
            </a>
          );
        },
        table: ({ children, ...props }) => (
          <div className="max-w-full overflow-x-auto">
            <table {...props}>{children}</table>
          </div>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function MessageBlock({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={cn("flex flex-col gap-1.5", isUser && "items-end")}>
      <div className={cn("flex items-center gap-2", isUser && "flex-row-reverse")}>
        <span className="text-xs font-medium text-foreground capitalize">{message.role}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{time}</span>
      </div>
      <div
        className={cn(
          "min-w-0 max-w-[85%] rounded-lg px-4 py-3 text-sm leading-relaxed",
          isUser
            ? "whitespace-pre-wrap bg-primary text-primary-foreground shadow-glow"
            : [
                "glass-panel prose prose-sm max-w-none break-words text-foreground",
                "prose-headings:mb-2 prose-headings:mt-4 prose-headings:text-foreground",
                "prose-p:my-2 prose-p:text-foreground prose-ul:my-2 prose-ol:my-2",
                "prose-li:my-0.5 prose-li:text-foreground prose-strong:text-foreground",
                "prose-blockquote:border-foreground/15 prose-blockquote:text-muted-foreground",
                "prose-a:text-primary prose-a:cursor-pointer prose-a:no-underline hover:prose-a:underline",
                "prose-code:break-words prose-code:font-mono prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none",
                "prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:whitespace-pre prose-pre:rounded-lg prose-pre:border prose-pre:border-foreground/10 prose-pre:bg-surface-secondary/60",
                "prose-table:my-2 prose-th:text-foreground prose-td:text-foreground",
                "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
              ]
        )}
      >
        {isUser ? message.content : <MarkdownMessage content={message.content} />}
      </div>
    </div>
  );
}

export function ChatPanel({ className }: { className?: string }) {
  const currentId = useChatStore((s) => s.currentId);
  const sessions = useChatStore((s) => s.sessions);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isDictating = useChatStore((s) => s.isDictating);
  const isTranscribing = useChatStore((s) => s.isTranscribing);
  const { addMessage, setDictating, setTranscribing } = useChatStore((s) => s.actions);
  const [input, setInput] = useState("");
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [dictationEnabled, setDictationEnabled] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<DictationRecorder | null>(null);

  const session = currentId ? sessions[currentId] : null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages.length, isStreaming, isTranscribing]);

  useEffect(() => {
    void api
      .config()
      .then((config) => setDictationEnabled(config.dictation?.enabled ?? false))
      .catch(() => setDictationEnabled(false));
  }, []);

  useEffect(() => {
    return () => {
      void recorderRef.current?.cancel();
      recorderRef.current = null;
      setDictating(false);
      setTranscribing(false);
    };
  }, [setDictating, setTranscribing]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !currentId || isStreaming || isDictating || isTranscribing) return;
    setInput("");
    addMessage(currentId, { role: "user", content: text });
    await simulateAssistantReply(currentId, text);
  };

  const finishDictation = async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setDictating(false);
    setLevel(0);
    if (!recorder) return;

    const { pcm, seconds: recorded } = await recorder.stop();
    if (recorded < 0.4) {
      setDictationError("That was too short — tap Dictate and speak for a moment.");
      return;
    }

    setTranscribing(true);
    try {
      const result = await transcribeClip(pcm);
      const text = result.text.trim();
      if (!text) {
        setDictationError("No speech was detected in that clip.");
        return;
      }
      setInput((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (err) {
      setDictationError(err instanceof Error ? err.message : "dictation failed");
    } finally {
      setTranscribing(false);
    }
  };

  const toggleDictation = async () => {
    if (isTranscribing) return;
    if (isDictating) {
      await finishDictation();
      return;
    }

    setDictationError(null);

    if (electron?.permissions?.request) {
      try {
        await electron.permissions.request("microphone");
      } catch {
        // continue — getUserMedia will surface the real failure
      }
    }

    const recorder = new DictationRecorder({
      onLevel: setLevel,
      onTick: setSeconds,
      onAutoStop: () => void finishDictation(),
    });
    recorderRef.current = recorder;
    setSeconds(0);

    try {
      await recorder.start();
      setDictating(true);
    } catch (err) {
      recorderRef.current = null;
      setDictationError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in system settings and try again."
          : err instanceof Error
            ? err.message
            : "could not open the microphone"
      );
    }
  };

  const busy = isStreaming || isDictating || isTranscribing;

  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <PageHeader title="Assistant" description={findMainSection("home")?.description} />

      <div className="flex-1 overflow-y-auto scrollbar-minimal px-6 py-6">
        <div className="flex flex-col gap-6 max-w-3xl mx-auto">
          {session?.messages.length === 0 && (
            <EmptyState
              className="py-16"
              title="Start a conversation"
              description="Your assistant can search your screen history, recordings, and connected apps."
            />
          )}
          {session?.messages.map((msg) => (
            <MessageBlock key={msg.id} message={msg} />
          ))}
          {isStreaming && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:300ms]" />
              </span>
              Thinking…
            </div>
          )}
          {dictationError && <p className="text-sm text-destructive">{dictationError}</p>}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="p-4 shrink-0 border-t border-foreground/10 bg-background/40 backdrop-blur-md">
        <div className="max-w-3xl mx-auto flex flex-col gap-2">
          {(isDictating || isTranscribing) && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {isDictating ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
                  </span>
                  <span>Listening — tap Stop when you're done</span>
                  <span className="tabular-nums">
                    {seconds}s / {DICTATION_MAX_SECONDS}s
                  </span>
                  <span className="ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-foreground/10">
                    <span
                      className="block h-full rounded-full bg-primary transition-[width] duration-100"
                      style={{ width: `${Math.round(level * 100)}%` }}
                    />
                  </span>
                </>
              ) : (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Transcribing…</span>
                </>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={
                isDictating
                  ? "Speak now…"
                  : isTranscribing
                    ? "Transcribing your dictation…"
                    : "Ask anything…"
              }
              className="flex-1"
              disabled={isDictating || isTranscribing}
            />
            {dictationEnabled && (
              <Button
                type="button"
                variant={isDictating ? "destructive" : "outline"}
                onClick={() => void toggleDictation()}
                disabled={isStreaming || isTranscribing || !currentId}
                className="shrink-0 gap-2"
                title={isDictating ? "Stop and transcribe" : "Dictate a message"}
              >
                {isDictating ? (
                  <Square className="w-3.5 h-3.5" />
                ) : isTranscribing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Mic className="w-3.5 h-3.5" />
                )}
                {isDictating ? "Stop" : "Dictate"}
              </Button>
            )}
            <Button
              onClick={handleSend}
              disabled={!input.trim() || busy}
              className="gap-2 shrink-0"
            >
              Send
              <Send className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
