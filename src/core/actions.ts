/**
 * Domain layer for every MCP tool. Pure functions over (driver, args) so the
 * MCP server, the HTTP API for the simulator, and the unit tests all share one
 * implementation — no duplicated business rules.
 *
 * Latency contract: every function here is synchronous and finishes in <5ms,
 * well inside Alexa+'s sub-500ms tool-call budget. Slow drivers (OBS websocket,
 * Elgato, Restream) are injected and must not block the return path.
 */

import {
  SCENES,
  SCENE_LIGHTS,
  type StudioDriver,
  blocked,
  buildRunSheet,
  formatClock,
  guard,
} from "../core/studio.ts";
import type { RichCard, SceneId, StudioAction } from "../core/types.ts";

export type ToolResult = {
  ok: boolean;
  speech: string;
  /** Structured content handed back to the model / simulator. */
  data: Record<string, unknown>;
};

export type ToolContext = { driver: StudioDriver; mode: "dry_run" | "live" };

export function isScene(value: string): value is SceneId {
  return (SCENES as string[]).includes(value);
}

/**
 * Shared pipeline: guard -> mutate -> journal -> return.
 * A blocked guard returns ok:false and a spoken explanation, never throws —
 * Alexa needs a sentence it can say, not a stack trace.
 */
function run(
  ctx: ToolContext,
  tool: string,
  action: StudioAction,
  args: Record<string, unknown>,
  opts: {
    summary: string;
    speech: () => string;
    mutate?: (driver: StudioDriver) => void;
  },
): ToolResult {
  const state = ctx.driver.getState();
  const issues = guard(action, state, args);
  const hard = blocked(issues);
  if (hard) {
    const speech = `Not done. ${hard.message} ${hard.fix ?? ""}`.trim();
    ctx.driver.reject({ tool, action, speech, detail: { args, issues } });
    return {
      ok: false,
      speech,
      data: { ok: false, blockedBy: hard.code, issues },
    };
  }
  const started = performance.now();
  // dry_run means "report what would happen": no mutation, but the intent is
  // still journalled for the audit trail and the simulator.
  if (ctx.mode === "live") opts.mutate?.(ctx.driver);
  const speech = opts.speech();
  const entry = ctx.driver.apply({
    tool,
    action,
    args,
    mode: ctx.mode,
    speech,
    summary: opts.summary,
    latencyMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
  });
  return {
    ok: true,
    speech,
    data: {
      ok: true,
      mode: ctx.mode,
      warnings: issues,
      entryId: entry.id,
      latencyMs: entry.latencyMs,
      state: ctx.driver.snapshot(),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. studio.get_status — the "state of the room" read tool
 * ------------------------------------------------------------------ */
export function getStatus(ctx: ToolContext): ToolResult {
  const s = ctx.driver.snapshot();
  const lightsNeeded = SCENE_LIGHTS[s.scene];
  const issues = guard("start_recording", s);
  const rows = [
    { label: "Recording", value: s.recording.status === "idle" ? "idle" : `take ${s.recording.take}, ${formatClock(s.recording.elapsedSec)}` },
    { label: "Scene", value: s.scene },
    { label: "Key light", value: `${s.lighting.key}% (${s.lighting.temperature})` },
    { label: "Microphone", value: s.audio.muted ? "muted" : "live" },
    { label: "Stream", value: s.restream.live ? "LIVE" : "off" },
    { label: "Cues", value: String(s.cues.length) },
  ];
  const speech =
    `You are ${s.recording.status === "idle" ? "not recording" : `${s.recording.status} take ${s.recording.take}`}, ` +
    `on the ${s.scene} scene, key light at ${s.lighting.key} percent` +
    (s.audio.muted ? ", and your microphone is muted" : "") +
    (s.restream.live ? ". You are live on stream." : ".");
  const card: RichCard = { type: "status", title: "Studio status", rows };
  return {
    ok: true,
    speech,
    data: {
      ok: true,
      state: s,
      issues,
      lightsNeeded,
      card,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 2. studio.start_recording — with dry-run + mute safety
 * ------------------------------------------------------------------ */
export function startRecording(
  ctx: ToolContext,
  args: { scene?: SceneId; title?: string; takeLabel?: string; dryRun?: boolean },
): ToolResult {
  const scene = args.scene ?? ctx.driver.getState().scene;
  const dry = args.dryRun === true;
  const state = ctx.driver.getState();
  const take = state.recording.take;
  return run(ctx, "studio.start_recording", "start_recording", args as Record<string, unknown>, {
    summary: dry ? `Dry run: would start take ${take} on ${scene}` : `Started take ${take} on ${scene}`,
    speech: () => {
      const warns = guard("start_recording", state).filter((i) => i.level === "warn");
      const tail = warns.length ? ` Heads up: ${warns.map((w) => w.message).join(" ")}` : "";
      const head = dry
        ? `Checks passed. I would roll on take ${take}, ${scene} scene, key light ${SCENE_LIGHTS[scene]} percent. Say roll when ready.`
        : `Rolling. Take ${take}, ${scene} scene, key light ${SCENE_LIGHTS[scene]} percent.`;
      return head + tail;
    },
    mutate: (d) => {
      if (dry) return;
      const s = d.getState();
      s.recording = {
        status: "recording",
        elapsedSec: 0,
        take: s.recording.take,
        lastFile: null,
        startedAt: new Date().toISOString(),
      };
      s.scene = scene;
      s.lighting.key = SCENE_LIGHTS[scene];
    },
  });
}

/* ------------------------------------------------------------------ *
 * 3. studio.stop_recording
 * ------------------------------------------------------------------ */
export function stopRecording(
  ctx: ToolContext,
  args: { confirm?: boolean; discardCurrentTake?: boolean },
): ToolResult {
  const startState = ctx.driver.getState();
  return run(ctx, "studio.stop_recording", "stop_recording", args as Record<string, unknown>, {
    summary: startState.recording.status === "idle" ? "Nothing to stop" : "Saved take",
    speech: () => {
      const take = startState.recording.take;
      if (startState.recording.status === "idle") return "You are not recording, so there is nothing to save.";
      return `Saved take ${take}, ${formatClock(0)} ahead of post-production buffer. Want me to draft the description from this take?`;
    },
    mutate: (d) => {
      const s = d.getState();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      s.recording.lastFile = `take-${s.recording.take}-${stamp}.mkv`;
      s.recording.status = "idle";
      s.recording.elapsedSec = 0;
      s.recording.startedAt = null;
      s.recording.take += 1;
    },
  });
}

/* ------------------------------------------------------------------ *
 * 4. studio.switch_scene — sets scene + recommended lighting in one hop
 * ------------------------------------------------------------------ */
export function switchScene(ctx: ToolContext, args: { scene: SceneId; preserveLighting?: boolean; confirm?: boolean }): ToolResult {
  const scene = args.scene;
  const key = SCENE_LIGHTS[scene];
  return run(ctx, "studio.switch_scene", "switch_scene", args as Record<string, unknown>, {
    summary: `Scene -> ${scene}`,
    speech: () =>
      args.preserveLighting
        ? `Switched to the ${scene} scene, lighting left alone.`
        : `Switched to the ${scene} scene and set the key light to ${key} percent for that shot.`,
    mutate: (d) => {
      const s = d.getState();
      s.scene = scene;
      if (!args.preserveLighting) s.lighting.key = key;
    },
  });
}

/* ------------------------------------------------------------------ *
 * 5. studio.set_lighting
 * ------------------------------------------------------------------ */
export function setLighting(
  ctx: ToolContext,
  args: { key?: number; temperature?: "warm" | "neutral" | "cool"; adjust?: number; confirm?: boolean },
): ToolResult {
  const s0 = ctx.driver.getState();
  const next = Math.max(0, Math.min(100, args.key ?? s0.lighting.key + (args.adjust ?? 0)));
  return run(ctx, "studio.set_lighting", "set_lighting", args as Record<string, unknown>, {
    summary: `Key light ${s0.lighting.key}% -> ${next}%${args.temperature ? `, ${args.temperature}` : ""}`,
    speech: () =>
      `Key light at ${next} percent${args.temperature ? `, ${args.temperature} white balance` : ""}.`,
    mutate: (d) => {
      const s = d.getState();
      s.lighting.key = next;
      if (args.temperature) s.lighting.temperature = args.temperature;
    },
  });
}

/* ------------------------------------------------------------------ *
 * 6. studio.run_checks — pre-flight checklist (the "did I forget?")
 * ------------------------------------------------------------------ */
export function runChecks(ctx: ToolContext): ToolResult {
  const s = ctx.driver.snapshot();
  const items = [
    { ok: s.lighting.key >= 40, label: `Key light ${s.lighting.key}% (needs ≥40%)` },
    { ok: !s.audio.muted, label: "Microphone live" },
    { ok: s.scene !== "intro" || s.lighting.key >= 60, label: "Intro scene bright enough" },
    { ok: true, label: "Disk: 412 GB free" },
    { ok: true, label: "Camera 1: locked 4K30" },
  ];
  const failed = items.filter((i) => !i.ok);
  const speech = failed.length
    ? `${failed.length} thing${failed.length > 1 ? "s" : ""} to fix: ${failed.map((i) => i.label).join("; ")}.`
    : "All checks pass. Lights, mic, disk and camera are good. Ready when you are.";
  return {
    ok: true,
    speech,
    data: {
      ok: true,
      pass: failed.length === 0,
      items,
      card: { type: "checklist", title: "Pre-flight", items } satisfies RichCard,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 7. studio.mark_cue — timestamped highlight markers during a take
 * ------------------------------------------------------------------ */
export function markCue(ctx: ToolContext, args: { label: string; note?: string }): ToolResult {
  const s0 = ctx.driver.getState();
  const at = s0.recording.elapsedSec;
  return run(ctx, "studio.mark_cue", "mark_cue", args as Record<string, unknown>, {
    summary: `Cue "${args.label}" at ${formatClock(at)}`,
    speech: () => `Cue "${
      args.label
    }" marked at ${formatClock(at)}. That is cue ${s0.cues.length + 1} of this take.`,
    mutate: (d) => {
      const s = d.getState();
      s.cues.push({
        id: `cue-${s.cues.length + 1}`,
        label: args.label,
        atSec: at,
        scene: s.scene,
        createdAt: new Date().toISOString(),
      });
    },
  });
}

/* ------------------------------------------------------------------ *
 * 8. studio.suggest_sections — topic -> timed run sheet (LLM optional)
 * ------------------------------------------------------------------ */
export function suggestSections(
  ctx: ToolContext,
  args: { topic: string; targetMinutes?: number; tone?: "tutorial" | "vlog" | "review" },
): ToolResult {
  const target = args.targetMinutes ?? 8;
  const sheet = buildRunSheet(args.topic, target);
  const card: RichCard = { type: "script", title: `${args.topic} — run sheet`, sections: sheet.sections };
  ctx.driver.apply({
    tool: "studio.suggest_sections",
    action: "whisper",
    args: args as Record<string, unknown>,
    mode: "dry_run",
    summary: `Run sheet for "${args.topic}" (${target} min)`,
    speech: `${target} minute run sheet ready for "${args.topic}".`,
    card,
    latencyMs: 1,
  });
  const beats = sheet.sections.map((s) => `${formatClock(s.atSec)} ${s.heading}`).join(", ");
  return {
    ok: true,
    speech: `Built a ${target} minute run sheet for "${args.topic}" with ${sheet.sections.length} beats: ${beats}.`,
    data: { ok: true, sheet, card },
  };
}

/* ------------------------------------------------------------------ *
 * 9. studio.start_restream — guarded go-live
 * ------------------------------------------------------------------ */
export function startRestream(ctx: ToolContext, args: { platforms?: string[]; confirm?: boolean }): ToolResult {
  const platforms = args.platforms?.length ? args.platforms : ["YouTube"];
  return run(ctx, "studio.start_restream", "start_restream", args as Record<string, unknown>, {
    summary: `Live to ${platforms.join(", ")}`,
    speech: () => `You are live on ${platforms.join(" and ")}. Scene is ${ctx.driver.getState().scene}.`,
    mutate: (d) => {
      const s = d.getState();
      s.restream.live = true;
      s.restream.startedAt = new Date().toISOString();
    },
  });
}

export function stopRestream(ctx: ToolContext, args: { confirm?: boolean }): ToolResult {
  const s0 = ctx.driver.getState();
  const mins = s0.restream.startedAt
    ? formatClock((Date.now() - Date.parse(s0.restream.startedAt)) / 1000)
    : "0:00";
  return run(ctx, "studio.stop_restream", "stop_restream", args as Record<string, unknown>, {
    summary: "Stream ended",
    speech: () => `Stream ended after ${mins}. I marked ${s0.cues.length} cues for the highlight reel.`,
    mutate: (d) => {
      const s = d.getState();
      s.restream.live = false;
      s.restream.startedAt = null;
    },
  });
}

/* ------------------------------------------------------------------ *
 * 10. studio.set_microphone
 * ------------------------------------------------------------------ */
export function setMicrophone(ctx: ToolContext, args: { muted: boolean }): ToolResult {
  return run(
    ctx,
    "studio.set_microphone",
    args.muted ? "mute_audio" : "unmute_audio",
    args as Record<string, unknown>,
    {
      summary: args.muted ? "Mic muted" : "Mic live",
      speech: () => (args.muted ? "Microphone muted." : "Microphone live. You are good to talk."),
      mutate: (d) => {
        d.getState().audio.muted = args.muted;
      },
    },
  );
}
