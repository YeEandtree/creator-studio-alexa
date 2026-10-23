// Inspect (and drive) the real OBS instance over obs-websocket.
//   node scripts\obs-inspect.mjs                -> list scenes + record state
//   node scripts\obs-inspect.mjs "Camera Close" -> switch to that scene
//   OBS_URL=ws://127.0.0.1:4456 ...             -> custom endpoint
import OBSWebSocket from "obs-websocket-js/json";

const obs = new OBSWebSocket();
const url = process.env.OBS_URL ?? `ws://127.0.0.1:${process.env.OBS_PORT ?? 4456}`;
try {
  await obs.connect(url);
} catch (e) {
  console.log(`OBS not reachable at ${url} - ${e.message}`);
  process.exit(1);
}

// NOTE: obs-websocket returns scenes oldest-first; the real scene list is the
// `scenes` array from GetSceneList, not `scene_order` from the scene JSON.
const sceneInfo = await obs.call("GetSceneList");
const names = (Array.isArray(sceneInfo.scenes) ? sceneInfo.scenes : []).map((s) => s.sceneName);
const current = sceneInfo.currentProgramSceneName;
console.log("current program scene:", current ?? "(none)");
console.log("scenes:", names.length ? names.join(" | ") : "(empty)");

const target = process.argv[2];
if (target) {
  if (names.includes(target)) {
    await obs.call("SetCurrentProgramScene", { sceneName: target });
    const after = await obs.call("GetCurrentProgramScene");
    console.log("switched ->", after.currentProgramSceneName);
  } else {
    console.log(`scene "${target}" does not exist`);
  }
}

try {
  const rec = await obs.call("GetRecordStatus");
  console.log("recording:", rec.outputActive, "| timecode:", rec.outputTimecode ?? "-");
} catch (e) {
  console.log("record status unavailable:", e.message.slice(0, 60));
}

await obs.disconnect();
setTimeout(() => process.exit(0), 150);
