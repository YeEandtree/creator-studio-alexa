import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StudioDriver } from "../src/core/studio.ts";
import { createStudioServer } from "../src/mcp/server.ts";

async function connect(mode: "dry_run" | "live" = "live") {
  const driver = new StudioDriver();
  const server = createStudioServer({ driver, mode });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
  return { client, driver };
}

test("MCP handshake lists all 18 studio tools with annotations", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 18);
  const names = tools.map((t) => t.name).sort();
  assert.ok(names.includes("studio.get_status"));
  assert.ok(names.includes("studio.mark_cue"));
  const status = tools.find((t) => t.name === "studio.get_status")!;
  assert.equal(status.annotations?.readOnlyHint, true);
  const stop = tools.find((t) => t.name === "studio.stop_recording")!;
  assert.equal(stop.annotations?.destructiveHint, true);
  await client.close();
});

test("MCP tool calls return speech content + structuredContent", async () => {
  const { client, driver } = await connect();
  const res = await client.callTool({ name: "studio.start_recording", arguments: { scene: "intro" } });
  assert.equal(res.isError ?? false, false);
  assert.match((res.content as any)[0].text, /Rolling/);
  const structured = res.structuredContent as any;
  assert.equal(structured.ok, true);
  assert.equal(structured.state.recording.status, "recording");
  assert.ok(structured.latencyMs < 500, "tool latency within the Alexa+ budget");
  assert.equal(driver.getState().recording.status, "recording");
  await client.close();
});

test("MCP rejects a destructive action while live as a tool error with spoken text", async () => {
  const { client } = await connect();
  await client.callTool({ name: "studio.start_restream", arguments: { platforms: ["YouTube"] } });
  const res = await client.callTool({ name: "studio.stop_restream", arguments: {} });
  assert.equal(res.isError, true);
  assert.match((res.content as any)[0].text, /Not done/);
  const retry = await client.callTool({ name: "studio.stop_restream", arguments: { confirm: true } });
  assert.equal(retry.isError ?? false, false);
  await client.close();
});

test("MCP validates the input schema before running a tool", async () => {
  const { client } = await connect();
  const res = await client.callTool({ name: "studio.switch_scene", arguments: { scene: "kitchen" } });
  assert.equal(res.isError, true);
  await client.close();
});

test("MCP exposes the plan_utterance prompt for host models", async () => {
  const { client } = await connect();
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "creatorstudio.plan_utterance"));
  const prompt = await client.getPrompt({ name: "creatorstudio.plan_utterance", arguments: { utterance: "roll a take" } });
  assert.match((prompt.messages[0].content as any).text, /studio\.start_recording/);
  await client.close();
});
