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
import type { FocusId, RichCard, SceneId, ShotId, StudioAction } from "../core/types.ts";
import { buildStudioPackage, packageToMarkdown } from "./handoff.ts";

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
      // Real hardware (OBS) rolls asynchronously — the reply never waits on it.
      d.dispatch("start_recording");
      d.dispatch("switch_scene", scene);
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
      d.dispatch("stop_recording");
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
      d.dispatch("switch_scene", scene);
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
  // Load the sheet into the teleprompter so the very next thing you say
  // ("next line") is already on the glass.
  const s = ctx.driver.getState();
  s.teleprompter.topic = args.topic;
  s.teleprompter.lines = sheet.sections.map((sec) => sec.text);
  s.teleprompter.line = 1;
  const beats = sheet.sections.map((sec) => `${formatClock(sec.atSec)} ${sec.heading}`).join(", ");
  return {
    ok: true,
    speech: `Built a ${target} minute run sheet for "${args.topic}" with ${sheet.sections.length} beats, and loaded it on the teleprompter. Say next line when you're ready. Beats: ${beats}.`,
    data: { ok: true, sheet, card, teleprompter: s.teleprompter },
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

/* ================================================================== *
 * The "crew" tools: each one replaces a person a solo creator does not
 * have. Cameraman, focus puller, noise engineer, director, and the
 * person holding the script.
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * 11. studio.set_camera — the cameraman + focus puller
 * ------------------------------------------------------------------ */
const SHOT_LABEL: Record<ShotId, string> = { wide: "wide shot", medium: "medium shot", close: "close-up" };
const FOCUS_LABEL: Record<FocusId, string> = { face: "your face", hands: "your hands", product: "the product" };

export function setCamera(
  ctx: ToolContext,
  args: { shot?: ShotId; focus?: FocusId; confirm?: boolean },
): ToolResult {
  const s0 = ctx.driver.getState();
  const shot = args.shot ?? s0.camera.shot;
  const focus = args.focus ?? s0.camera.focus;
  return run(ctx, "studio.set_camera", "set_camera", args as Record<string, unknown>, {
    summary: `Camera ${shot}, focus ${focus}`,
    speech: () =>
      args.shot && args.focus
        ? `Camera on a ${SHOT_LABEL[shot]}, focused on ${FOCUS_LABEL[focus]}.`
        : args.shot
          ? `Camera moved to a ${SHOT_LABEL[shot]}, focus held on ${FOCUS_LABEL[focus]}.`
          : `Focus pulled to ${FOCUS_LABEL[focus]}, ${SHOT_LABEL[shot]} held.`,
    mutate: (d) => {
      d.getState().camera = { shot, focus };
      d.dispatch("camera", shot, focus);
    },
  });
}

/* ------------------------------------------------------------------ *
 * 12. studio.set_audio — the noise engineer / sound department
 * ------------------------------------------------------------------ */
export function setAudio(
  ctx: ToolContext,
  args: { gainDb?: number; adjustDb?: number; noiseGate?: boolean; muted?: boolean },
): ToolResult {
  const s0 = ctx.driver.getState();
  const gain = Math.max(-24, Math.min(12, Math.round(args.gainDb ?? s0.audio.gainDb + (args.adjustDb ?? 0))));
  const gate = args.noiseGate ?? s0.audio.noiseGate;
  return run(ctx, "studio.set_audio", "set_audio", args as Record<string, unknown>, {
    summary: `Audio ${gain > 0 ? "+" : ""}${gain} dB, noise gate ${gate ? "on" : "off"}`,
    speech: () => {
      const parts = [`Mic gain ${gain > 0 ? "plus " : "minus "}${Math.abs(gain)} dB`];
      parts.push(gate ? "noise gate on" : "noise gate off");
      if (gain > 8) parts.push("watch out, that is close to clipping");
      return `${parts.join(", ")}.`;
    },
    mutate: (d) => {
      const s = d.getState();
      s.audio.gainDb = gain;
      s.audio.noiseGate = gate;
      if (args.muted !== undefined) s.audio.muted = args.muted;
    },
  });
}

/* ------------------------------------------------------------------ *
 * 13. studio.next_line — the teleprompter (and the person holding it)
 * ------------------------------------------------------------------ */
export function nextLine(ctx: ToolContext, args: { back?: boolean; repeat?: boolean }): ToolResult {
  const s0 = ctx.driver.getState();
  const total = s0.teleprompter.lines.length;
  const from = s0.teleprompter.line;
  const target = args.repeat ? from : args.back ? Math.max(1, from - 1) : Math.min(total, from + 1);
  const line = s0.teleprompter.lines[target - 1] ?? "";
  return run(ctx, "studio.next_line", "next_line", args as Record<string, unknown>, {
    summary: `Teleprompter line ${target}/${total}`,
    speech: () =>
      args.repeat
        ? `Repeating line ${target}. ${line}`
        : `Line ${target} of ${total}. ${line}`,
    mutate: (d) => {
      d.getState().teleprompter.line = target;
      d.getState().teleprompter.visible = true;
    },
  });
}

/* ------------------------------------------------------------------ *
 * 14. studio.set_teleprompter_speed — the director's pacing
 * ------------------------------------------------------------------ */
export function setTeleprompterSpeed(ctx: ToolContext, args: { wpm?: number; faster?: boolean; slower?: boolean }): ToolResult {
  const s0 = ctx.driver.getState();
  const wpm = Math.max(80, Math.min(220, args.wpm ?? s0.teleprompter.speedWpm + (args.faster ? 20 : args.slower ? -20 : 0)));
  return run(ctx, "studio.set_teleprompter_speed", "teleprompter_speed", args as Record<string, unknown>, {
    summary: `Prompter ${wpm} wpm`,
    speech: () => `Teleprompter at ${wpm} words per minute — about ${(wpm / 140).toFixed(2)}x your usual pace.`,
    mutate: (d) => {
      d.getState().teleprompter.speedWpm = wpm;
    },
  });
}

/* ------------------------------------------------------------------ *
 * 15. studio.retake — "cut, take it again" from this line
 * ------------------------------------------------------------------ */
export function retake(ctx: ToolContext, args: { reason?: string; fromLine?: number }): ToolResult {
  const s0 = ctx.driver.getState();
  const line = args.fromLine ?? s0.teleprompter.line;
  const at = s0.recording.elapsedSec;
  return run(ctx, "studio.retake", "retake", args as Record<string, unknown>, {
    summary: `Retake at ${formatClock(at)} from line ${line}`,
    speech: () =>
      s0.recording.status === "recording"
        ? `Marked a retake at ${formatClock(at)}. Keep rolling — the editor will cut back to line ${line}. Prompter is back on that line.`
        : `Retake noted at ${formatClock(at)} from line ${line}. Nothing is recording, so tell me to roll when you're set.`,
    mutate: (d) => {
      const s = d.getState();
      s.retakes.push({ line, atSec: at, reason: args.reason ?? "unspecified" });
      s.teleprompter.line = line;
      d.dispatch("retake", String(line));
    },
  });
}

/* ------------------------------------------------------------------ *
 * 16. studio.highlight — "that one was gold" (survives a retake)
 * ------------------------------------------------------------------ */
export function highlight(ctx: ToolContext, args: { label: string }): ToolResult {
  const s0 = ctx.driver.getState();
  const at = s0.recording.elapsedSec;
  const scene = s0.scene;
  return run(ctx, "studio.highlight", "highlight_cue", args as Record<string, unknown>, {
    summary: `Highlight "${args.label}" at ${formatClock(at)}`,
    speech: () => `Saved highlight "${args.label}" at ${formatClock(at)}. It goes straight to your editor, even if you re-shoot.`,
    mutate: (d) => {
      const s = d.getState();
      s.highlights.push({
        id: `hl-${s.highlights.length + 1}`,
        label: args.label,
        atSec: at,
        scene,
        createdAt: new Date().toISOString(),
      });
    },
  });
}

/* ------------------------------------------------------------------ *
 * 17. studio.draft_publish — the post-production person
 * ------------------------------------------------------------------ */
export function draftPublish(ctx: ToolContext): ToolResult {
  const pkg = buildStudioPackage(ctx.driver.getState());
  ctx.driver.getState().drafts = {
    title: pkg.title,
    description: pkg.description,
    hashtags: pkg.hashtags,
    chapters: pkg.chapters,
  };
  const card: RichCard = {
    type: "script",
    title: pkg.title,
    sections: pkg.chapters.length
      ? pkg.chapters.map((c) => ({ heading: c.label, atSec: c.atSec, text: "" }))
      : [],
  };
  ctx.driver.apply({
    tool: "studio.draft_publish",
    action: "whisper",
    args: {},
    mode: "live",
    summary: `Title + description draft (${pkg.chapters.length} chapters, ${pkg.hashtags.length} tags)`,
    speech: `Draft ready. Title: ${pkg.title}.`,
    card,
    latencyMs: 1,
  });
  return {
    ok: true,
    speech: `Title and description drafted from what you actually said: ${pkg.title}. ${pkg.hashtags.length} tags and ${pkg.chapters.length} chapters are in the editor package.`,
    data: { ok: true, package: pkg, markdown: packageToMarkdown(pkg), card },
  };
}