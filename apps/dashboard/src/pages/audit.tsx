import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, JsonView, OutcomeBadge, PageHeader, SourceBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type AuditEntry } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLoader } from "@/lib/hooks";
import { absoluteTime, cn, relativeTime } from "@/lib/utils";

const PAGE = 100;

interface Filters {
  userId: string;
  server: string;
  outcome: string;
  source: string;
}

export function AuditPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [filters, setFilters] = useState<Filters>({ userId: "", server: "", outcome: "", source: "" });
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data: users } = useLoader(() => (isAdmin ? api.users() : Promise.resolve({ users: [] })), [isAdmin]);
  const { data: servers } = useLoader(() => api.servers());

  // Fresh load whenever filters change.
  const loadFirst = useCallback(async () => {
    try {
      const r = await api.audit({ ...filters, limit: PAGE });
      setEntries(r.entries);
      setHasMore(r.entries.length === PAGE);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    setLoading(true);
    setExpanded(new Set());
    void loadFirst();
  }, [loadFirst]);

  // Auto-refresh prepends new rows without losing already-loaded older pages.
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(async () => {
      try {
        const r = await api.audit({ ...filters, limit: PAGE });
        setEntries((prev) => {
          const top = prev[0]?.id ?? 0;
          const fresh = r.entries.filter((e) => e.id > top);
          return fresh.length ? [...fresh, ...prev] : prev;
        });
      } catch {
        /* transient; next tick retries */
      }
    }, 5000);
    return () => clearInterval(t);
  }, [auto, filters]);

  const loadMore = async () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    try {
      const r = await api.audit({ ...filters, before: last.id, limit: PAGE });
      setEntries((prev) => [...prev, ...r.entries]);
      setHasMore(r.entries.length === PAGE);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const cols = isAdmin ? 8 : 7;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description={isAdmin ? "Every tool call through the gateway — who, which server and tool, when, how long, and the outcome." : "Your tool calls through the gateway."}
        actions={
          <>
            <label className="text-muted-foreground flex items-center gap-2 text-sm">
              <Switch checked={auto} onCheckedChange={setAuto} /> Live
            </label>
            <Button variant="outline" size="sm" onClick={() => void loadFirst()}>
              <RefreshCw /> Refresh
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        {isAdmin && (
          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs">User</Label>
            <NativeSelect value={filters.userId} onChange={set("userId")} className="h-8 min-w-40">
              <option value="">All users</option>
              {(users?.users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-muted-foreground text-xs">Server</Label>
          <NativeSelect value={filters.server} onChange={set("server")} className="h-8 min-w-36">
            <option value="">All servers</option>
            {(servers?.servers ?? []).map((s) => (
              <option key={s.id} value={s.slug}>
                {s.slug}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label className="text-muted-foreground text-xs">Outcome</Label>
          <NativeSelect value={filters.outcome} onChange={set("outcome")} className="h-8">
            <option value="">Any outcome</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
            <option value="denied">denied</option>
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label className="text-muted-foreground text-xs">Source</Label>
          <NativeSelect value={filters.source} onChange={set("source")} className="h-8">
            <option value="">Any source</option>
            <option value="mcp">mcp (external clients)</option>
            <option value="chat">chat (dashboard agent)</option>
          </NativeSelect>
        </div>
      </div>

      {loading ? (
        <div className="bg-muted/50 h-48 animate-pulse rounded-xl border" />
      ) : entries.length === 0 ? (
        <EmptyState title="No audit entries">Tool calls from MCP clients and the chat agent appear here.</EmptyState>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6 pl-3" />
                <TableHead>Time</TableHead>
                {isAdmin && <TableHead>User</TableHead>}
                <TableHead>Source</TableHead>
                <TableHead>Server / tool</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="pr-4">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => {
                const open = expanded.has(e.id);
                return (
                  <Fragment key={e.id}>
                    <TableRow className="cursor-pointer" onClick={() => toggle(e.id)}>
                      <TableCell className="pl-3">
                        {open ? <ChevronDown className="text-muted-foreground size-4" /> : <ChevronRight className="text-muted-foreground size-4" />}
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap" title={absoluteTime(e.ts)}>
                        {relativeTime(e.ts)}
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="max-w-48 truncate" title={e.apiKeyPrefix ? `key ${e.apiKeyPrefix}…` : undefined}>
                          {e.userEmail ?? <span className="text-muted-foreground">unknown</span>}
                        </TableCell>
                      )}
                      <TableCell>
                        <SourceBadge source={e.source} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {e.event === "auth" ? (
                          <span className="text-muted-foreground">auth{e.tool ? ` · ${e.tool}` : ""}</span>
                        ) : (
                          <>
                            <span className="text-muted-foreground">{e.server ?? "?"}__</span>
                            {e.tool}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{e.durationMs != null ? `${e.durationMs} ms` : "—"}</TableCell>
                      <TableCell>
                        <OutcomeBadge outcome={e.outcome} />
                      </TableCell>
                      <TableCell className={cn("max-w-72 truncate pr-4 text-xs", e.outcome === "ok" ? "text-muted-foreground" : "text-red-600 dark:text-red-400")}>
                        {e.error ?? ""}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={cols} className="bg-muted/30 px-4 py-3">
                          <div className="grid gap-3 text-xs md:grid-cols-[1fr_2fr]">
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                              <dt className="text-muted-foreground">Time</dt>
                              <dd>{absoluteTime(e.ts)}</dd>
                              <dt className="text-muted-foreground">User</dt>
                              <dd>{e.userEmail ?? "—"}</dd>
                              <dt className="text-muted-foreground">API key</dt>
                              <dd className="font-mono">{e.apiKeyPrefix ? `${e.apiKeyPrefix}…` : e.source === "chat" ? "dashboard session" : "—"}</dd>
                              <dt className="text-muted-foreground">Event</dt>
                              <dd>{e.event}</dd>
                              {e.error && (
                                <>
                                  <dt className="text-muted-foreground">Error</dt>
                                  <dd className="break-words text-red-600 dark:text-red-400">{e.error}</dd>
                                </>
                              )}
                            </dl>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">Arguments</p>
                              <JsonView value={e.args ?? {}} />
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
