// Give each OBS scene something visible to render (a solid colour source),
// so switching scenes in the demo produces a real picture.
//   node scripts\setup-obs-scenes.mjs           (auto-detects the WebSocket port)
//   OBS_PORT=4456 ...                          (override)
import fs from "node:fs";
import path from "node:path";
import OBSWebSocket from "obs-websocket-js/json";

const base = process.env.OBS_CONFIG ?? path.resolve(process.cwd(), "..", "_obs", "obs", "config", "obs-studio");
const wsConfig = path.join(base, "plugin_config", "obs-websocket", "config.json");

// 1) make sure the WebSocket server is enabled on the port we expect
fs.mkdirSync(path.dirname(wsConfig), { recursive: true });
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(wsConfig, "utf8"));
} catch {
  cfg = {};
}
const port = Number(process.env.OBS_PORT ?? 4456);
const next = { ...cfg, server_enabled: true, auth_required: false, enable_web_socket_auth: false, port };
fs.writeFileSync(wsConfig, JSON.stringify(next, null, 4));
console.log(`obs-websocket -> port ${port}, auth off (${wsConfig})`);

// 2) try to fill every scene with a colour source
const obs = new OBSWebSocket();
const url = process.env.OBS_URL ?? `ws://127.0.0.1:${port}`;
try {
  await obs.connect(url);
} catch (e) {
  console.log(`OBS not reachable at ${url} (${e.message}).`);
  console.log("Config written. Restart OBS, then run this script again to add the colour sources.");
  process.exit(0);
}

const { scenes } = await obs.call("GetSceneList");
for (const { sceneName } of scenes) {
  try {
    await obs.call("CreateInput", {
      sceneName,
      inputName: `${sceneName} bg`,
      inputKind: "color_source_v3",
      inputSettings: { color: 0x16233a, width: 1920, height: 1080 },
      sceneItemEnabled: true,
    });
    console.log("filled ", sceneName);
  } catch (e) {
    console.log("skip   ", sceneName, "-", e.message.slice(0, 70));
  }
}

await obs.call("SetCurrentProgramScene", { sceneName: scenes[0]?.sceneName ?? "Camera Medium" });
const cur = await obs.call("GetCurrentProgramScene");
console.log("program scene:", cur.currentProgramSceneName);
await obs.disconnect();
setTimeout(() => process.exit(0), 200);
