import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { KeyRound, Plus } from "lucide-react";
import { Confirm } from "@/components/confirm";
import { CodeBlock, EmptyState, PageHeader } from "@/components/common";
import { KeyRevealDialog } from "@/components/key-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type ApiKey, type CreatedKey } from "@/lib/api";
import { act, useLoader } from "@/lib/hooks";
import { absoluteTime, relativeTime } from "@/lib/utils";

export function KeysPage() {
  const { data: cfg } = useLoader(() => api.config());
  const { data, loading, reload } = useLoader(() => api.keys());
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [busy, setBusy] = useState(false);
  const mcpUrl = cfg?.mcpUrl ?? `${window.location.origin}/mcp`;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const k = await api.createKey(name.trim() || "default");
      setCreated(k);
      setName("");
      void reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="API keys" description="Personal keys for connecting MCP clients (Claude Code, Cursor, MCP Inspector) to the gateway." />

      <Card>
        <CardHeader>
          <CardTitle>Gateway endpoint</CardTitle>
          <CardDescription>
            One URL for every enabled server. Authenticate with <code className="font-mono text-xs">Authorization: Bearer &lt;your key&gt;</code>. You never
            need the upstream servers' credentials.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock value={mcpUrl} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create a key</CardTitle>
          <CardDescription>Use one key per device or client so you can revoke them independently.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-col gap-2 sm:flex-row">
            <Input placeholder="Key name, e.g. laptop-claude-code" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            <Button type="submit" disabled={busy}>
              <Plus /> Generate key
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-medium">Your keys</h2>
        {loading && !data ? (
          <div className="bg-muted/50 h-24 animate-pulse rounded-xl border" />
        ) : !data?.keys.length ? (
          <EmptyState title="No API keys yet">Generate one above to connect an MCP client.</EmptyState>
        ) : (
          <Card className="py-0">
            <KeyTable keys={data.keys} onRevoked={reload} />
          </Card>
        )}
      </div>

      <KeyRevealDialog created={created} mcpUrl={mcpUrl} onClose={() => setCreated(null)} />
    </div>
  );
}

export function KeyTable({ keys, onRevoked, showOwner = false }: { keys: ApiKey[]; onRevoked: () => void; showOwner?: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Name</TableHead>
          {showOwner && <TableHead>Owner</TableHead>}
          <TableHead>Key</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.map((k) => (
          <TableRow key={k.id} className={k.revokedAt ? "opacity-60" : undefined}>
            <TableCell className="pl-4 font-medium">
              <span className="inline-flex items-center gap-2">
                <KeyRound className="text-muted-foreground size-3.5" />
                {k.name}
              </span>
            </TableCell>
            {showOwner && <TableCell className="text-muted-foreground">{k.userEmail}</TableCell>}
            <TableCell>
              <code className="font-mono text-xs">{k.prefix}…</code>
            </TableCell>
            <TableCell className="text-muted-foreground" title={absoluteTime(k.createdAt)}>
              {relativeTime(k.createdAt)}
            </TableCell>
            <TableCell className="text-muted-foreground" title={absoluteTime(k.lastUsedAt)}>
              {relativeTime(k.lastUsedAt)}
            </TableCell>
            <TableCell>
              {k.revokedAt ? (
                <Badge variant="destructive" title={absoluteTime(k.revokedAt)}>
                  revoked
                </Badge>
              ) : (
                <Badge variant="success">active</Badge>
              )}
            </TableCell>
            <TableCell className="pr-4 text-right">
              {!k.revokedAt && (
                <Confirm
                  title={`Revoke "${k.name}"?`}
                  description="Clients using this key are disconnected and their next call is rejected. This cannot be undone."
                  confirmLabel="Revoke key"
                  onConfirm={() => act(() => api.revokeKey(k.id), "Key revoked").then(onRevoked)}
                >
                  {(open) => (
                    <Button variant="outline" size="sm" onClick={open}>
                      Revoke
                    </Button>
                  )}
                </Confirm>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
