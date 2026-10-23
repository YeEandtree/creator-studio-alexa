/**
 * A fake obs-websocket v5 server for offline testing of the OBS driver.
 *
 *   node scripts/fake-obs.mjs 4456
 *
 * Then: STUDIO_MODE=live OBS_URL=ws://127.0.0.1:4456 npm start
 * This proves the real driver code path (connect → identify → StartRecord /
 * SetCurrentProgramScene) without installing OBS on the demo machine.
 */
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? 4456);
const wss = new WebSocketServer({ port });
const seen = [];

wss.on("connection", (ws) => {
  console.log("[fake-obs] client connected");
  // Hello (op 0) — rpcVersion 1, no authentication challenge.
  ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1 } }));
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.op === 1) {
      console.log(`[fake-obs] identify rpcVersion=${msg.d.rpcVersion}`);
      ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      return;
    }
    if (msg.op === 6) {
      const { requestType, requestId } = msg.d;
      seen.push(requestType);
      console.log(`[fake-obs] ${requestType}`);
      const responseData =
        requestType === "GetSceneList"
          ? { currentProgramSceneName: "Main", scenes: [] }
          : requestType === "StopRecord"
            ? { outputPath: "/tmp/take-1.mkv" }
            : {};
      ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } }));
    }
  });
});

console.log(`[fake-obs] obs-websocket v5 stub listening on ws://127.0.0.1:${port}`);
