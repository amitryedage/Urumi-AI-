import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Bot, Check, ChevronDown, ChevronRight, Info, Loader2, RotateCcw, Square, TriangleAlert, X } from "lucide-react";
import { JsonView } from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { api, streamChat, type AppConfig } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

interface ToolCall {
  id: string;
  name: string;
  server: string;
  tool: string;
  input: unknown;
  status: "running" | "ok" | "error";
  durationMs?: number;
  preview?: string;
}

/** Assistant turns are an ordered list of text segments and tool calls, as they streamed in. */
type Part = { kind: "text"; text: string } | { kind: "tool"; call: ToolCall } | { kind: "error"; message: string };

interface Message {
  role: "user" | "assistant";
  text?: string; // user
  parts?: Part[]; // assistant
  pending?: boolean;
}

const SUGGESTIONS = [
  "What orders came in today?",
  "Create a product called 'Demo Hoodie' priced at 39.99",
  "List today's orders and convert the total to EUR",
];

const finalText = (m: Message) =>
  m.role === "user" ? (m.text ?? "") : (m.parts ?? []).filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("");

export function ChatPage() {
  const { user } = useAuth();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const updateLast = (fn: (m: Message) => Message) =>
    setMessages((prev) => {
      const next = [...prev];
      next[next.length - 1] = fn(next[next.length - 1]!);
      return next;
    });

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    const history = [...messages, { role: "user" as const, text: content }];
    const payload = history.map((m) => ({ role: m.role, content: finalText(m) })).filter((m) => m.content.trim());
    setMessages([...history, { role: "assistant", parts: [], pending: true }]);
    setInput("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await streamChat(
        payload,
        (e) => {
          switch (e.type) {
            case "text":
              updateLast((m) => {
                const parts = [...(m.parts ?? [])];
                const last = parts[parts.length - 1];
                if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + e.delta };
                else parts.push({ kind: "text", text: e.delta });
                return { ...m, parts };
              });
              break;
            case "tool_call":
              updateLast((m) => ({
                ...m,
                parts: [...(m.parts ?? []), { kind: "tool", call: { id: e.id, name: e.name, server: e.server, tool: e.tool, input: e.input, status: "running" } }],
              }));
              break;
            case "tool_result":
              updateLast((m) => ({
                ...m,
                parts: (m.parts ?? []).map((p) =>
                  p.kind === "tool" && p.call.id === e.id
                    ? { kind: "tool", call: { ...p.call, status: e.ok ? "ok" : "error", durationMs: e.durationMs, preview: e.preview } }
                    : p,
                ),
              }));
              break;
            case "error":
              updateLast((m) => ({ ...m, parts: [...(m.parts ?? []), { kind: "error", message: e.message }] }));
              break;
            case "done":
              updateLast((m) => ({ ...m, pending: false }));
              break;
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        updateLast((m) => ({ ...m, parts: [...(m.parts ?? []), { kind: "error", message: (err as Error).message }] }));
      }
    } finally {
      updateLast((m) => ({ ...m, pending: false }));
      setBusy(false);
      abortRef.current = null;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  return (
    <div className="flex h-[calc(100svh-7.5rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Chat</h1>
          <p className="text-muted-foreground text-sm">
            Acting as <span className="text-foreground font-medium">{user?.name}</span>
            {config && (
              <>
                {" "}· model <code className="font-mono text-xs">{config.llm.model}</code>
                <span className="text-muted-foreground/70"> ({config.llm.provider})</span>
              </>
            )}{" "}
            · every tool call is audited under your account.
          </p>
        </div>
        {messages.length > 0 && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setMessages([])}>
            <RotateCcw /> New chat
          </Button>
        )}
      </div>

      {config && !config.llm.configured && (
        <Alert variant="warning" className="mt-4">
          <Info />
          <AlertDescription>
            No LLM API key is configured on the gateway. Set one in the Helm values (llm secret) to enable the agent.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex-1 overflow-y-auto py-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full border">
              <Bot className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">Ask anything your team's tools can answer</p>
              <p className="text-muted-foreground text-sm">The agent calls tools from every enabled MCP server through the gateway.</p>
            </div>
            <div className="flex max-w-2xl flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} variant="outline" size="sm" className="h-auto py-1.5 whitespace-normal" onClick={() => void send(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2 text-sm whitespace-pre-wrap">{m.text}</div>
                </div>
              ) : (
                <AssistantMessage key={i} message={m} />
              ),
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-3xl">
        <div className="bg-card focus-within:ring-ring/50 relative rounded-xl border shadow-xs focus-within:ring-[3px]">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about orders, products, or anything your tools can do…"
            rows={2}
            className="max-h-48 resize-none border-0 bg-transparent pr-14 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="absolute right-2 bottom-2">
            {busy ? (
              <Button size="icon-sm" variant="secondary" aria-label="Stop" onClick={() => abortRef.current?.abort()}>
                <Square className="size-3.5" />
              </Button>
            ) : (
              <Button size="icon-sm" aria-label="Send" disabled={!input.trim()} onClick={() => void send(input)}>
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
        <p className="text-muted-foreground mt-2 text-center text-xs">Enter to send · Shift+Enter for a new line</p>
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: Message }) {
  const parts = message.parts ?? [];
  return (
    <div className="flex gap-3">
      <div className="bg-muted mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {parts.map((p, i) =>
          p.kind === "text" ? (
            <Markdown key={i} text={p.text} />
          ) : p.kind === "tool" ? (
            <ToolChip key={p.call.id} call={p.call} />
          ) : (
            <Alert key={i} variant="destructive">
              <TriangleAlert />
              <AlertDescription>{p.message}</AlertDescription>
            </Alert>
          ),
        )}
        {message.pending && parts.length === 0 && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Thinking…
          </div>
        )}
      </div>
    </div>
  );
}

function ToolChip({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-muted/30 rounded-lg border text-sm">
      <button className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)}>
        {call.status === "running" ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : call.status === "ok" ? (
          <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <X className="size-4 text-red-600 dark:text-red-400" />
        )}
        <Badge variant="outline" className="font-mono">
          {call.server}
        </Badge>
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{call.tool}</code>
        {call.durationMs != null && <span className="text-muted-foreground text-xs tabular-nums">{call.durationMs} ms</span>}
        {open ? <ChevronDown className="text-muted-foreground size-4" /> : <ChevronRight className="text-muted-foreground size-4" />}
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-medium">Input</p>
            <JsonView value={call.input} />
          </div>
          {call.preview !== undefined && (
            <div className="space-y-1">
              <p className={cn("text-xs font-medium", call.status === "error" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                {call.status === "error" ? "Error" : "Result"}
              </p>
              <JsonView value={call.preview} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed break-words",
        "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
        "[&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold",
        "[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
        "[&_pre]:bg-muted [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-md [&_table]:text-xs",
        "[&_th]:bg-muted [&_th]:border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_td]:border [&_td]:px-2 [&_td]:py-1.5",
        "[&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          table: ({ node: _node, ...props }) => (
            <div className="overflow-x-auto">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
