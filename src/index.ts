/**
 * HTTP entry point.
 *
 *   POST/GET/DELETE /mcp   -> MCP Streamable HTTP endpoint (spec 2025-11-25+)
 *   GET  /healthz          -> liveness probe for hosts like Render/Fly
 *   GET  /api/*            -> JSON API used by the Alexa+ simulator page
 *   GET  /                 -> the simulator page
 *
 * Two MCP endpoint flavours are exposed:
 *   /mcp          stateless (no session id) — what Alexa+ add-ons use for
 *                 short, independent tool turns; horizontally scalable.
 *   /mcp/session  stateful — keep-alive sessions for hosts that want
 *                 resumable SSE streams and server-initiated messages.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StudioDriver } from "./core/studio.ts";
import { executeRouted, routeUtterance } from "./core/router.ts";
import { createStudioServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Static UI lives at <repo>/public. Works both for `node src/index.ts`
// (here = <repo>/src) and for the build output (here = <repo>/dist/src), and
// can be overridden for container images.
function resolvePublicDir(): string {
  if (process.env.PUBLIC_DIR) return path.resolve(process.env.PUBLIC_DIR);
  let dir = here;
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(dir, "public");
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
    dir = path.dirname(dir);
  }
  return path.join(here, "..", "..", "public");
}
const PUBLIC_DIR = resolvePublicDir();

const driver = new StudioDriver();
const mode = (process.env.STUDIO_MODE as "dry_run" | "live") || "dry_run";
const port = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "256kb" }));

// CORS: allowed for the browser simulator and for MCP hosts on other origins.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOW_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const sessions = new Map<string, StreamableHTTPServerTransport>();

/* --------------------------- stateless MCP --------------------------- */
app.post("/mcp", async (req, res) => {
  const server = createStudioServer({ driver, mode });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] stateless request failed", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

/* ---------------------------- stateful MCP --------------------------- */
app.post("/mcp/session", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session; send an initialize request first" },
          id: null,
        });
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) sessions.delete(transport!.sessionId);
      };
      const server = createStudioServer({ driver, mode });
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] session request failed", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

async function handleSessionStream(req: express.Request, res: express.Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? sessions.get(sessionId) : undefined;
  if (!transport) {
    return res.status(400).send("Invalid or missing session ID");
  }
  await transport.handleRequest(req, res);
}
app.get("/mcp/session", handleSessionStream);
app.delete("/mcp/session", handleSessionStream);

/* ------------------------------- API -------------------------------- */
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, mode, sessions: sessions.size });
});

app.get("/api/state", (_req, res) => {
  res.json({ state: driver.snapshot(), journal: driver.journal().slice(-40), mode });
});

app.post("/api/reset", (_req, res) => {
  res.json({ state: driver.reset(), journal: [] });
});

app.post("/api/command", (req, res) => {
  const utterance = String(req.body?.utterance ?? "").slice(0, 400);
  if (!utterance) return res.status(400).json({ error: "utterance is required" });
  const t0 = performance.now();
  const routed = routeUtterance(utterance);
  const result = executeRouted(driver, routed);
  const totalMs = Math.round((performance.now() - t0) * 100) / 100;
  res.json({ routed, result, totalMs, state: driver.snapshot() });
});

/* ---------------------------- static UI ----------------------------- */
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[http] unhandled", err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(port, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on http://localhost:${port}  (mode=${mode})`);
  console.log(`  MCP (stateless, Streamable HTTP): POST http://localhost:${port}/mcp`);
  console.log(`  MCP (stateful sessions):          POST http://localhost:${port}/mcp/session`);
  console.log(`  Simulator:                        http://localhost:${port}/`);
});
