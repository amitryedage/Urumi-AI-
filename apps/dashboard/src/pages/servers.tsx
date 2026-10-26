import { useEffect, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, Pencil, Plus, RefreshCw, Server as ServerIcon, Trash2, TriangleAlert } from "lucide-react";
import { Confirm } from "@/components/confirm";
import { EmptyState, PageHeader, StatusDot } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type Server, type ServerInput, type ServerStat } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { act, useLoader } from "@/lib/hooks";
import { cn, relativeTime } from "@/lib/utils";

export function ServersPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, loading, reload } = useLoader(() => api.servers(), [], 5000);
  const { data: stats } = useLoader(() => api.stats(), [], 15000);
  const [editing, setEditing] = useState<Server | "new" | null>(null);

  const servers = data?.servers ?? [];
  const statBySlug = new Map((stats?.servers ?? []).map((s) => [s.server ?? "", s]));
  const connected = servers.filter((s) => s.status === "connected");
  const toolCount = connected.reduce((n, s) => n + s.tools.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP servers"
        description={
          <>
            {connected.length} of {servers.length} servers connected · {toolCount} tools available through one gateway endpoint.
          </>
        }
        actions={
          isAdmin && (
            <Button onClick={() => setEditing("new")}>
              <Plus /> Add server
            </Button>
          )
        }
      />

      {loading && !data ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-muted/50 h-24 animate-pulse rounded-xl border" />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <EmptyState title="No MCP servers registered">
          {isAdmin ? "Add your first upstream server to expose its tools through the gateway." : "Ask an admin to register a server."}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} stat={statBySlug.get(s.slug)} isAdmin={isAdmin} onEdit={() => setEditing(s)} reload={reload} />
          ))}
        </div>
      )}

      {isAdmin && (
        <ServerDialog
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function ServerCard({
  server: s,
  stat,
  isAdmin,
  onEdit,
  reload,
}: {
  server: Server;
  stat?: ServerStat;
  isAdmin: boolean;
  onEdit: () => void;
  reload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const toggleRestricted = (tool: string, restricted: boolean) => {
    const next = restricted ? [...new Set([...s.restrictedTools, tool])] : s.restrictedTools.filter((t) => t !== tool);
    void act(() => api.updateServer(s.id, { restrictedTools: next }), restricted ? `${tool} is now admin-only` : `${tool} is available to everyone`).then(reload);
  };

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <button className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left" onClick={() => setOpen((o) => !o)}>
          <div className="bg-muted mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border">
            <ServerIcon className="text-muted-foreground size-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <span className="text-muted-foreground font-mono text-xs">{s.slug}</span>
              {s.source === "helm" && <Badge variant="outline">helm</Badge>}
              {s.authType && s.authType !== "none" && (
                <Badge variant="secondary">{s.authType === "bearer" ? "bearer token" : `header ${s.authHeader ?? ""}`}</Badge>
              )}
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <StatusDot status={s.status} />
              <span>{s.status === "connected" ? `${s.tools.length} tools` : "no tools"}</span>
              {s.latencyMs != null && s.status === "connected" && <span>{s.latencyMs} ms list latency</span>}
              {s.lastCheckedAt && <span>checked {relativeTime(s.lastCheckedAt)}</span>}
              {stat && (
                <span>
                  24h: {stat.calls} calls · {stat.errors} errors{stat.avgMs != null ? ` · avg ${stat.avgMs} ms` : ""}
                </span>
              )}
            </div>
            {s.url && <div className="text-muted-foreground truncate font-mono text-xs">{s.url}</div>}
          </div>
          {open ? <ChevronDown className="text-muted-foreground mt-2 size-4" /> : <ChevronRight className="text-muted-foreground mt-2 size-4" />}
        </button>

        <div className="flex items-center gap-1 sm:pl-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              await act(() => api.refreshServer(s.id));
              await reload();
              setRefreshing(false);
            }}
          >
            <RefreshCw className={cn(refreshing && "animate-spin")} />
          </Button>
          {isAdmin && (
            <>
              <div className="flex items-center gap-2 px-2" title={s.enabled ? "Disable" : "Enable"}>
                <Switch
                  checked={s.enabled}
                  onCheckedChange={(enabled) =>
                    void act(() => api.updateServer(s.id, { enabled }), enabled ? `${s.name} enabled` : `${s.name} disabled`).then(reload)
                  }
                />
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Edit" onClick={onEdit}>
                <Pencil />
              </Button>
              <Confirm
                title={`Remove ${s.name}?`}
                description="Its tools disappear from every client and the chat agent immediately. Audit history is kept."
                confirmLabel="Remove server"
                onConfirm={() => act(() => api.deleteServer(s.id), `${s.name} removed`).then(reload)}
              >
                {(openConfirm) => (
                  <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={openConfirm}>
                    <Trash2 />
                  </Button>
                )}
              </Confirm>
            </>
          )}
        </div>
      </div>

      {s.status === "unreachable" && s.lastError && (
        <div className="border-t border-red-500/20 bg-red-500/5 px-4 py-2 text-xs text-red-600 dark:text-red-400">
          <span className="inline-flex items-start gap-1.5">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span className="font-mono break-all">{s.lastError}</span>
          </span>
        </div>
      )}

      {open && (
        <div className="bg-muted/30 border-t">
          {s.tools.length === 0 ? (
            <p className="text-muted-foreground px-4 py-6 text-center text-sm">
              {s.status === "disabled" ? "Server is disabled — its tools are hidden from every client." : "No tools available right now."}
            </p>
          ) : (
            <ul className="divide-y">
              {s.tools.map((t) => (
                <li key={t.name} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-[13px]">{t.qualifiedName}</code>
                      {t.restricted && <Badge variant="warning">admin only</Badge>}
                      {t.readOnly === true && <Badge variant="outline">read-only</Badge>}
                    </div>
                    {t.description && <p className="text-muted-foreground line-clamp-2 text-xs">{t.description}</p>}
                  </div>
                  {isAdmin && (
                    <label className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
                      Admins only
                      <Switch checked={t.restricted} onCheckedChange={(v) => toggleRestricted(t.name, v)} />
                    </label>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

interface FormState {
  slug: string;
  name: string;
  url: string;
  authType: "none" | "bearer" | "header";
  authHeader: string;
  credential: string;
  timeoutMs: string;
  enabled: boolean;
}

const emptyForm: FormState = {
  slug: "",
  name: "",
  url: "",
  authType: "none",
  authHeader: "X-API-Key",
  credential: "",
  timeoutMs: "15000",
  enabled: true,
};

function ServerDialog({ target, onClose, onSaved }: { target: Server | "new" | null; onClose: () => void; onSaved: () => void }) {
  const isNew = target === "new";
  const editing = target && target !== "new" ? target : null;
  const [f, setF] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    if (target === "new") setF(emptyForm);
    else
      setF({
        slug: target.slug,
        name: target.name,
        url: target.url ?? "",
        authType: target.authType ?? "none",
        authHeader: target.authHeader ?? "X-API-Key",
        credential: "",
        timeoutMs: String(target.timeoutMs),
        enabled: target.enabled,
      });
  }, [target]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const body: ServerInput = {
      name: f.name.trim(),
      url: f.url.trim(),
      authType: f.authType,
      authHeader: f.authType === "header" ? f.authHeader.trim() : null,
      timeoutMs: Number(f.timeoutMs),
      enabled: f.enabled,
    };
    // Blank credential on edit = keep the stored one.
    if (f.credential) body.credential = f.credential;
    const ok = await act(
      () => (isNew ? api.createServer({ ...body, slug: f.slug.trim() }) : api.updateServer(editing!.id, body)),
      isNew ? `${f.name} added` : `${f.name} updated`,
    );
    setBusy(false);
    if (ok) onSaved();
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? "Add MCP server" : `Edit ${editing?.name}`}</DialogTitle>
          <DialogDescription>
            Upstream servers must speak MCP over Streamable HTTP. Credentials are encrypted at rest and never leave the gateway.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="srv-name">Name</Label>
              <Input id="srv-name" required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Toolbox" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="srv-slug">Slug</Label>
              <Input
                id="srv-slug"
                required
                disabled={!isNew}
                className="font-mono"
                pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?"
                title="lowercase letters, digits and dashes"
                value={f.slug}
                onChange={(e) => set("slug", e.target.value.toLowerCase())}
                placeholder="toolbox"
              />
              <p className="text-muted-foreground text-xs">Tool prefix: <code className="font-mono">{f.slug || "slug"}__tool</code></p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="srv-url">URL</Label>
            <Input
              id="srv-url"
              type="url"
              required
              className="font-mono"
              value={f.url}
              onChange={(e) => set("url", e.target.value)}
              placeholder="http://toolbox.mcp-gateway.svc.cluster.local:8080/mcp"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="srv-auth">Authentication</Label>
              <NativeSelect id="srv-auth" className="w-full" value={f.authType} onChange={(e) => set("authType", e.target.value as FormState["authType"])}>
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Custom header</option>
              </NativeSelect>
            </div>
            {f.authType === "header" && (
              <div className="space-y-2">
                <Label htmlFor="srv-header">Header name</Label>
                <Input id="srv-header" required className="font-mono" value={f.authHeader} onChange={(e) => set("authHeader", e.target.value)} />
              </div>
            )}
          </div>
          {f.authType !== "none" && (
            <div className="space-y-2">
              <Label htmlFor="srv-cred">Credential</Label>
              <Input
                id="srv-cred"
                type="password"
                autoComplete="off"
                required={isNew || !editing?.hasCredential}
                value={f.credential}
                onChange={(e) => set("credential", e.target.value)}
                placeholder={editing?.hasCredential ? "•••••••• (stored — leave blank to keep)" : ""}
              />
              {editing?.hasCredential && (
                <p className="text-muted-foreground text-xs">
                  Leave blank to keep the stored credential. If you change the URL you must re-enter it.
                </p>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="srv-timeout">Call timeout (ms)</Label>
              <Input id="srv-timeout" type="number" min={1000} max={120000} step={500} required value={f.timeoutMs} onChange={(e) => set("timeoutMs", e.target.value)} />
            </div>
            <div className="flex items-end gap-3 pb-2">
              <Switch id="srv-enabled" checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} />
              <Label htmlFor="srv-enabled">Enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : isNew ? "Add server" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
