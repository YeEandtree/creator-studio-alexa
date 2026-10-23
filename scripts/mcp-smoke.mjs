#!/usr/bin/env node
/**
 * Smoke test that speaks real MCP over Streamable HTTP against a running
 * CreatorStudio server — the same handshake an Alexa+ add-on performs.
 *
 *   node scripts/mcp-smoke.mjs http://localhost:8787
 *
 * It uses the official MCP SDK *client* (not our own code paths), so it also
 * validates the wire format, session handling and structuredContent shapes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? process.env.MCP_URL ?? "http://localhost:8787";
const url = new URL("/mcp", base);

const client = new Client({ name: "creatorstudio-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(url);
await client.connect(transport);

const t0 = performance.now();
const tools = await client.listTools();
const initMs = Math.round(performance.now() - t0);
console.log(`initialize + tools/list: ${tools.tools.length} tools in ${initMs} ms`);
for (const t of tools.tools) console.log(`  - ${t.name.padEnd(26)} ${t.annotations?.readOnlyHint ? "[read-only]" : ""}`);

const calls = [
  ["studio.get_status", {}],
  ["studio.run_checks", {}],
  ["studio.start_recording", { scene: "intro" }],
  ["studio.mark_cue", { label: "best hook" }],
  ["studio.set_lighting", { adjust: -10 }],
  ["studio.switch_scene", { scene: "broll" }],
  ["studio.suggest_sections", { topic: "unboxing the new mic", targetMinutes: 6 }],
  ["studio.start_restream", { platforms: ["YouTube"] }],
  ["studio.stop_recording", {}], // must be BLOCKED (live, no confirm)
  ["studio.stop_recording", { confirm: true }],
  ["studio.stop_restream", {}],
];

let blocked = 0;
let worst = 0;
for (const [name, args] of calls) {
  const s = performance.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = performance.now() - s;
  worst = Math.max(worst, ms);
  if (res.isError) blocked += 1;
  const text = res.content?.[0]?.text ?? "";
  console.log(`${res.isError ? "BLOCK " : "OK    "} ${name.padEnd(26)} ${ms.toFixed(1).padStart(6)} ms  ${text}`);
}
console.log(`\nblocked as designed: ${blocked}`);
console.log(`worst tool round-trip: ${worst.toFixed(1)} ms  (Alexa+ budget: <500 ms)`);
await client.close();
process.exit(worst < 500 && blocked === 1 ? 0 : 1);
