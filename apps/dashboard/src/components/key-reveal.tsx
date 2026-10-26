import { KeyRound, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CodeBlock } from "@/components/common";
import type { CreatedKey } from "@/lib/api";

export function clientConfigs(mcpUrl: string, key: string) {
  return {
    claude: `claude mcp add --transport http urumi-gateway ${mcpUrl} --header "Authorization: Bearer ${key}"`,
    cursor: JSON.stringify({ mcpServers: { "urumi-gateway": { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    inspector: `npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP
# URL: ${mcpUrl}
# Header: Authorization = Bearer ${key}`,
  };
}

/** Shows a freshly created API key exactly once, with ready-to-paste client configs. */
export function KeyRevealDialog({
  created,
  mcpUrl,
  ownerLabel,
  onClose,
}: {
  created: CreatedKey | null;
  mcpUrl: string;
  ownerLabel?: string;
  onClose: () => void;
}) {
  const cfg = created ? clientConfigs(mcpUrl, created.key) : null;
  return (
    <Dialog open={!!created} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" /> API key created
          </DialogTitle>
          <DialogDescription>
            {ownerLabel ? `Key "${created?.name}" for ${ownerLabel}. ` : `Key "${created?.name}". `}
            Copy it now — it is stored hashed and will never be shown again.
          </DialogDescription>
        </DialogHeader>
        {created && cfg && (
          <div className="space-y-4">
            <CodeBlock value={created.key} />
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription>Treat this key like a password. Revoke it from the dashboard if it leaks.</AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Claude Code</p>
              <CodeBlock value={cfg.claude} />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">
                Cursor <span className="text-muted-foreground font-normal">(~/.cursor/mcp.json)</span>
              </p>
              <CodeBlock value={cfg.cursor} />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">MCP Inspector</p>
              <CodeBlock value={cfg.inspector} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>I've copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
