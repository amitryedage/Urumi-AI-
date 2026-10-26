/** Tiny Prometheus exposition (no dependency): tool calls, errors and latency per upstream. */
import { registry } from "./registry.js";

const BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

const calls = new Map<string, number>(); // `${server}|${outcome}` -> count
const latency = new Map<string, { buckets: number[]; sum: number; count: number }>();

export const metrics = {
  toolCall(server: string, outcome: "ok" | "error" | "denied", ms: number) {
    const k = `${server}|${outcome}`;
    calls.set(k, (calls.get(k) ?? 0) + 1);
    if (outcome === "denied") return;
    const h = latency.get(server) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (ms <= b) h.buckets[i]!++;
    });
    h.sum += ms;
    h.count++;
    latency.set(server, h);
  },

  render(): string {
    const lines: string[] = [];
    lines.push("# HELP mcpgw_tool_calls_total Tool calls routed by the gateway.", "# TYPE mcpgw_tool_calls_total counter");
    for (const [k, v] of calls) {
      const [server, outcome] = k.split("|");
      lines.push(`mcpgw_tool_calls_total{server="${server}",outcome="${outcome}"} ${v}`);
    }
    lines.push("# HELP mcpgw_tool_call_duration_ms Upstream tool call latency.", "# TYPE mcpgw_tool_call_duration_ms histogram");
    for (const [server, h] of latency) {
      BUCKETS.forEach((b, i) => lines.push(`mcpgw_tool_call_duration_ms_bucket{server="${server}",le="${b}"} ${h.buckets[i]}`));
      lines.push(`mcpgw_tool_call_duration_ms_bucket{server="${server}",le="+Inf"} ${h.count}`);
      lines.push(`mcpgw_tool_call_duration_ms_sum{server="${server}"} ${h.sum}`);
      lines.push(`mcpgw_tool_call_duration_ms_count{server="${server}"} ${h.count}`);
    }
    lines.push("# HELP mcpgw_upstream_up 1 if the upstream is connected.", "# TYPE mcpgw_upstream_up gauge");
    lines.push("# HELP mcpgw_upstream_tools Number of tools exposed by the upstream.", "# TYPE mcpgw_upstream_tools gauge");
    for (const up of registry.list()) {
      lines.push(`mcpgw_upstream_up{server="${up.row.slug}",status="${up.status}"} ${up.status === "connected" ? 1 : 0}`);
      lines.push(`mcpgw_upstream_tools{server="${up.row.slug}"} ${up.tools.length}`);
    }
    return lines.join("\n") + "\n";
  },
};
