import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AuditEntry, ServerStatus } from "@/lib/api";
import { copy } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const STATUS: Record<ServerStatus, { label: string; dot: string; text: string }> = {
  connected: { label: "Connected", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
  unreachable: { label: "Unreachable", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  disabled: { label: "Disabled", dot: "bg-zinc-400", text: "text-muted-foreground" },
  connecting: { label: "Connecting", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
};

export function StatusDot({ status, className }: { status: ServerStatus; className?: string }) {
  const s = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", s.text, className)}>
      <span className="relative flex size-2">
        {status === "connected" && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-40", s.dot)} />}
        <span className={cn("relative inline-flex size-2 rounded-full", s.dot)} />
      </span>
      {s.label}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: AuditEntry["outcome"] }) {
  const variant = outcome === "ok" ? "success" : outcome === "error" ? "destructive" : "warning";
  return <Badge variant={variant}>{outcome}</Badge>;
}

export function SourceBadge({ source }: { source: string }) {
  return (
    <Badge variant={source === "chat" ? "info" : "secondary"} className="font-mono">
      {source}
    </Badge>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CopyButton({ value, label = "Copied" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Copy"
      onClick={async () => {
        await copy(value, label);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

/** Monospace block with a copy button. */
export function CodeBlock({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("bg-muted/60 relative rounded-md border", className)}>
      <pre className="overflow-x-auto p-3 pr-11 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{value}</pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={value} />
      </div>
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <pre className="bg-muted/60 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center text-sm">
      <p className="text-foreground font-medium">{title}</p>
      {children}
    </div>
  );
}
