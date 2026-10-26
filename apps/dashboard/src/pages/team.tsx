import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { KeyRound, Trash2, UserPlus } from "lucide-react";
import { Confirm } from "@/components/confirm";
import { CodeBlock, EmptyState, PageHeader } from "@/components/common";
import { KeyRevealDialog } from "@/components/key-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type CreatedKey, type Member, type Role } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { act, useLoader } from "@/lib/hooks";
import { absoluteTime, relativeTime } from "@/lib/utils";
import { KeyTable } from "./keys";

export function TeamPage() {
  const { user: me } = useAuth();
  const { data: cfg } = useLoader(() => api.config());
  const users = useLoader(() => api.users());
  const invites = useLoader(() => api.invites());
  const keys = useLoader(() => api.keys(true));
  const [inviteOpen, setInviteOpen] = useState(false);
  const [issueFor, setIssueFor] = useState<Member | null>(null);
  const [created, setCreated] = useState<{ key: CreatedKey; owner: string } | null>(null);
  const [keyFilter, setKeyFilter] = useState("");

  const reloadAll = () => {
    void users.reload();
    void keys.reload();
  };
  const mcpUrl = cfg?.mcpUrl ?? `${window.location.origin}/mcp`;
  const filteredKeys = (keys.data?.keys ?? []).filter((k) => !keyFilter || k.userId === keyFilter);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Team"
        description="Admins manage servers and members. Members use tools through their own API keys."
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus /> Invite member
          </Button>
        }
      />

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Active keys</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead className="pr-4 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(users.data?.users ?? []).map((u) => {
              const self = u.id === me?.id;
              return (
                <TableRow key={u.id} className={u.disabled ? "opacity-60" : undefined}>
                  <TableCell className="pl-4">
                    <div className="font-medium">
                      {u.name} {self && <span className="text-muted-foreground text-xs font-normal">(you)</span>}
                    </div>
                    <div className="text-muted-foreground text-xs">{u.email}</div>
                  </TableCell>
                  <TableCell>
                    {self ? (
                      <Badge>{u.role}</Badge>
                    ) : (
                      <NativeSelect
                        value={u.role}
                        className="h-8"
                        onChange={(e) => void act(() => api.updateUser(u.id, { role: e.target.value as Role }), `${u.name} is now ${e.target.value}`).then(reloadAll)}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </NativeSelect>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{u.activeKeys}</TableCell>
                  <TableCell className="text-muted-foreground" title={absoluteTime(u.lastActivity)}>
                    {u.lastActivity ? relativeTime(u.lastActivity) : "—"}
                  </TableCell>
                  <TableCell>
                    <Switch
                      disabled={self}
                      checked={!u.disabled}
                      onCheckedChange={(on) => void act(() => api.updateUser(u.id, { disabled: !on }), on ? `${u.name} enabled` : `${u.name} disabled`).then(reloadAll)}
                    />
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" disabled={u.disabled} onClick={() => setIssueFor(u)}>
                        <KeyRound /> Issue key
                      </Button>
                      {!self && (
                        <Confirm
                          title={`Remove ${u.name}?`}
                          description="Their account, sessions and API keys are deleted. Audit entries are kept."
                          confirmLabel="Remove member"
                          onConfirm={() => act(() => api.deleteUser(u.id), `${u.name} removed`).then(reloadAll)}
                        >
                          {(open) => (
                            <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={open}>
                              <Trash2 />
                            </Button>
                          )}
                        </Confirm>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {(invites.data?.invites.length ?? 0) > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Pending invites</h2>
          <Card className="py-0">
            <Table>
              <TableBody>
                {invites.data!.invites.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="pl-4 font-medium">{i.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{i.role}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground" title={absoluteTime(i.expiresAt)}>
                      expires {new Date(i.expiresAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button variant="ghost" size="sm" onClick={() => void act(() => api.deleteInvite(i.id), "Invite cancelled").then(invites.reload)}>
                        Cancel
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">All API keys</h2>
          <NativeSelect value={keyFilter} onChange={(e) => setKeyFilter(e.target.value)} className="h-8">
            <option value="">All members</option>
            {(users.data?.users ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        {filteredKeys.length === 0 ? (
          <EmptyState title="No keys" />
        ) : (
          <Card className="py-0">
            <KeyTable keys={filteredKeys} onRevoked={reloadAll} showOwner />
          </Card>
        )}
      </div>

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={invites.reload} />
      <IssueKeyDialog
        member={issueFor}
        onClose={() => setIssueFor(null)}
        onIssued={(key, owner) => {
          setIssueFor(null);
          setCreated({ key, owner });
          reloadAll();
        }}
      />
      <KeyRevealDialog created={created?.key ?? null} ownerLabel={created?.owner} mcpUrl={mcpUrl} onClose={() => setCreated(null)} />
    </div>
  );
}

function InviteDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setEmail("");
    setRole("member");
    setUrl(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createInvite(email.trim(), role);
      setUrl(r.url);
      onInvited();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a team member</DialogTitle>
          <DialogDescription>They set their own name and password from a one-time link (valid 7 days).</DialogDescription>
        </DialogHeader>
        {url ? (
          <div className="space-y-3">
            <p className="text-sm">Share this link with {email}:</p>
            <CodeBlock value={url} />
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inv-email">Email</Label>
              <Input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-role">Role</Label>
              <NativeSelect id="inv-role" className="w-full" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="member">Member — uses tools</option>
                <option value="admin">Admin — manages servers and members</option>
              </NativeSelect>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                Create invite link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function IssueKeyDialog({
  member,
  onClose,
  onIssued,
}: {
  member: Member | null;
  onClose: () => void;
  onIssued: (k: CreatedKey, owner: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!member) return;
    setBusy(true);
    try {
      const k = await api.createKey(name.trim() || "issued-by-admin", member.id);
      setName("");
      onIssued(k, member.email);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Issue a key for {member?.name}</DialogTitle>
          <DialogDescription>Calls made with this key are attributed to {member?.email} in the audit log.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="key-name">Key name</Label>
            <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. cursor-workstation" maxLength={80} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Issue key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
