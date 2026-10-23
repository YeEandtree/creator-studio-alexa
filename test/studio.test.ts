import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioDriver, formatClock, guard, initialState, buildRunSheet } from "../src/core/studio.ts";
import type { RichCard } from "../src/core/types.ts";
import { routeUtterance } from "../src/core/router.ts";
import {
  getStatus,
  markCue,
  runChecks,
  setLighting,
  startRecording,
  startRestream,
  stopRecording,
} from "../src/core/actions.ts";

test("formatClock handles minutes and hours", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(3725), "1:02:05");
});

test("guard blocks going live during another live session", () => {
  const s = initialState();
  s.restream.live = true;
  const issues = guard("start_restream", s);
  assert.equal(issues[0].level, "block");
  assert.equal(issues[0].code, "ALREADY_LIVE");
});

test("guard requires confirmation for destructive actions while live", () => {
  const s = initialState();
  s.restream.live = true;
  s.recording.status = "recording";
  assert.equal(guard("stop_recording", s)[0].code, "LIVE_NEEDS_CONFIRMATION");
  assert.equal(guard("stop_recording", s, { confirm: true }).some((i) => i.code === "LIVE_NEEDS_CONFIRMATION"), false);
});

test("guard warns when starting a take with a muted mic", () => {
  const s = initialState();
  s.audio.muted = true;
  const issues = guard("start_recording", s);
  assert.ok(issues.some((i) => i.code === "AUDIO_MUTED" && i.level === "warn"));
});

test("a full take lifecycle produces a saved file and advancing take number", () => {
  const d = new StudioDriver();
  const ctx = { driver: d, mode: "live" as const };
  const start = startRecording(ctx, { scene: "intro" });
  assert.equal(start.ok, true);
  assert.match(start.speech, /Rolling/);
  assert.equal(d.getState().recording.status, "recording");
  assert.equal(d.getState().scene, "intro");

  const stop = stopRecording(ctx, {});
  assert.equal(stop.ok, true);
  const s = d.getState();
  assert.equal(s.recording.status, "idle");
  assert.match(s.recording.lastFile ?? "", /^take-1-.*\.mkv$/);
  assert.equal(s.recording.take, 2);
});

test("dry run does not change recording state", () => {
  const d = new StudioDriver();
  const ctx = { driver: d, mode: "live" as const };
  const r = startRecording(ctx, { dryRun: true });
  assert.equal(r.ok, true);
  assert.match(r.speech, /would roll/);
  assert.equal(d.getState().recording.status, "idle");
});

test("a blocked action is journalled and returns ok:false", () => {
  const d = new StudioDriver();
  const ctx = { driver: d, mode: "live" as const };
  startRestream(ctx, { platforms: ["YouTube"] });
  // live now: destructive stop_recording without confirm must be blocked
  startRecording(ctx, {});
  const blocked = stopRecording(ctx, {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.data.blockedBy, "LIVE_NEEDS_CONFIRMATION");
  assert.equal(d.journal().at(-1)?.ok, false);
});

test("set_lighting clamps to 0..100 and supports relative adjust", () => {
  const d = new StudioDriver();
  const ctx = { driver: d, mode: "live" as const };
  setLighting(ctx, { key: 140 });
  assert.equal(d.getState().lighting.key, 100);
  setLighting(ctx, { key: 50 });
  setLighting(ctx, { adjust: -20 });
  assert.equal(d.getState().lighting.key, 30);
  assert.match(setLighting(ctx, { temperature: "warm" }).speech, /warm/);
});

test("mark_cue timestamps against recording elapsed time", () => {
  const d = new StudioDriver();
  const ctx = { driver: d, mode: "live" as const };
  startRecording(ctx, {});
  d.getState().recording.elapsedSec = 95;
  const r = markCue(ctx, { label: "best hook" });
  assert.equal(r.ok, true);
  const cue = d.getState().cues[0];
  assert.equal(cue.atSec, 95);
  assert.equal(cue.label, "best hook");
  assert.match(r.speech, /1:35/);
});

test("run_checks reports failing items as speech", () => {
  const d = new StudioDriver();
  const ctx = { driver: d, mode: "live" as const };
  assert.equal(runChecks(ctx).data.pass, true);
  setLighting(ctx, { key: 20 });
  d.getState().audio.muted = true;
  const r = runChecks(ctx);
  assert.equal(r.data.pass, false);
  assert.match(r.speech, /2 things to fix/);
});

test("get_status returns a rich card and a spoken summary", () => {
  const d = new StudioDriver();
  const r = getStatus({ driver: d, mode: "dry_run" });
  assert.equal((r.data.card as RichCard).type, "status");
  assert.match(r.speech, /not recording/);
});

test("buildRunSheet honours target length", () => {
  const sheet = buildRunSheet("test", 10);
  assert.equal(sheet.sections.length, 6);
  assert.equal(sheet.sections[0].atSec, 0);
  assert.ok(sheet.sections.at(-1)!.atSec <= 600);
});

test("router maps natural creator speech to the right tool", () => {
  const cases = [
    ["what's the studio looking like", "studio.get_status"],
    ["do a dry run", "studio.start_recording"],
    ["roll a take on the intro scene", "studio.start_recording"],
    ["mark that, the best take of the hook", "studio.mark_cue"],
    ["a bit darker", "studio.set_lighting"],
    ["key light to 80 percent", "studio.set_lighting"],
    ["switch to b-roll", "studio.switch_scene"],
    ["go live on youtube", "studio.start_restream"],
    ["stop the stream", "studio.stop_restream"],
    ["mute the mic", "studio.set_microphone"],
    ["that's a wrap", "studio.stop_recording"],
    ["am I ready to record", "studio.run_checks"],
    ["make me a run sheet for unboxing, 6 minutes", "studio.suggest_sections"],
  ];
  for (const [utterance, tool] of cases) {
    assert.equal(routeUtterance(utterance).tool, tool, utterance);
  }
  assert.deepEqual(routeUtterance("a bit darker").args.adjust, -10);
  assert.equal(routeUtterance("make me a run sheet for unboxing, 6 minutes").args.targetMinutes, 6);
});
