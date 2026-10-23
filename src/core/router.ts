/**
 * Slash-command intent router used by the simulator page (and by the
 * `POST /api/command` endpoint). It mimics the Alexa+ routing step: a spoken
 * utterance is mapped to one MCP tool + arguments, then executed.
 *
 * Registered as an MCP **prompt** (`creatorstudio.plan_utterance`) so any MCP
 * host — including Alexa+ — can reuse the same routing examples.
 */

import { isScene, type ToolResult } from "../core/actions.ts";
import type { StudioDriver } from "../core/studio.ts";
import type { FocusId, SceneId, ShotId } from "../core/types.ts";
import {
  getStatus,
  markCue,
  runChecks,
  setLighting,
  setMicrophone,
  startRecording,
  startRestream,
  stopRecording,
  stopRestream,
  suggestSections,
  switchScene,
  setCamera,
  setAudio,
  nextLine,
  setTeleprompterSpeed,
  retake,
  highlight,
} from "../core/actions.ts";

export type Routed = { tool: string; args: Record<string, unknown>; utterance: string };

const NUM_WORDS: Record<string, number> = {
  zero: 0, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

function parseLevel(text: string): number | undefined {
  const pct = text.match(/(\d{1,3})\s*(?:%|percent)/i);
  if (pct) return Math.min(100, Number(pct[1]));
  for (const [word, value] of Object.entries(NUM_WORDS)) {
    if (text.includes(word)) return value;
  }
  const rel = text.match(/(darker|dimmer|lower|brighter|lighter|higher)/i);
  if (rel) {
    const down = /darker|dimmer|lower/i.test(rel[1]);
    return undefined; // handled via adjust
  }
  return undefined;
}

function adjustLevel(text: string): number | undefined {
  if (!/darker|dimmer|lower|brighter|lighter|higher/i.test(text)) return undefined;
  const down = /darker|dimmer|lower/i.test(text);
  const big = /a lot|much/i.test(text) ? 25 : 10;
  return down ? -big : big;
}

export function routeUtterance(raw: string): Routed {
  const utterance = raw.trim();
  const t = utterance.toLowerCase();
  const base = { utterance };

  if (/\b(stop|end)\b.*\b(stream|live|broadcast)\b/.test(t) || /\bgo offline\b/.test(t)) {
    return { tool: "studio.stop_restream", args: {}, ...base };
  }
  if (/\b(go live|start (the )?(stream|live|broadcast)|stream(ing)? (to|on))\b/.test(t)) {
    const platforms = ["youtube", "twitch", "tiktok", "bilibili"].filter((p) => t.includes(p));
    const named = platforms.length
      ? platforms.map((p) => (p === "bilibili" ? "Bilibili" : p === "tiktok" ? "TikTok" : p[0].toUpperCase() + p.slice(1)))
      : undefined;
    return { tool: "studio.start_restream", args: { platforms: named, confirm: /confirm|i understand|yes go live/.test(t) }, ...base };
  }
  if (/\b(stop|end|cut|wrap)\b.*\b(record|tak|roll|shoot)/.test(t) || /\bthat'?s a wrap\b/.test(t) || t === "stop") {
    // 'cut, take it again' is a retake, not an end of take.
    if (/\b(take it again|one more take|again from the top|retake)\b/.test(t)) {
      return { tool: "studio.retake", args: { reason: utterance }, ...base };
    }
    return { tool: "studio.stop_recording", args: { confirm: /confirm|i understand/.test(t) }, ...base };
  }
  // "am I ready to record", "pre-flight", "check the setup" -> the checklist
  if (/\b(check|pre-? ?flight|sound good)\b/.test(t) || /^(am i|is everything|are we) (ready|good|set)\b/.test(t)) {
    return { tool: "studio.run_checks", args: {}, ...base };
  }
  if (/\b(record|roll|start (the )?tak|here we go|action|dry run)\b/.test(t) && !/\b(stop|switch|b-?roll scene)\b/.test(t)) {
    const scene = (["intro", "main", "broll", "outro"] as SceneId[]).find((s) => t.includes(s));
    return {
      tool: "studio.start_recording",
      args: { scene, dryRun: /dry run/.test(t) },
      ...base,
    };
  }
  if (/\b(mute|mic off|silence)\b/.test(t)) return { tool: "studio.set_microphone", args: { muted: true }, ...base };
  if (/\b(unmute|mic on|can you hear)\b/.test(t)) return { tool: "studio.set_microphone", args: { muted: false }, ...base };

  /* ---- the "crew": camera operator, prompter, director ---- */
  if (/\b(next line|prompter line|next prompt)\b/.test(t)) return { tool: "studio.next_line", args: {}, ...base };
  if (/\b(previous line|go back a line|back a line|last line)\b/.test(t)) return { tool: "studio.next_line", args: { back: true }, ...base };
  if (/\b(repeat|say it again|say that again)\b/.test(t)) return { tool: "studio.next_line", args: { repeat: true }, ...base };
  if (/\b(retake|take it again|one more take|again from the top|redo this line)\b/.test(t)) {
    return { tool: "studio.retake", args: { reason: utterance }, ...base };
  }
  if (/\b(slower|faster|speed up|slow down|pace|tempo)\b/.test(t)) {
    const wpm = Number(t.match(/(\d{2,3})\s*(?:wpm|words)/)?.[1]) || undefined;
    return {
      tool: "studio.set_teleprompter_speed",
      args: { wpm, faster: /\bfaster|speed up\b/.test(t), slower: /\bslower|slow down\b/.test(t) },
      ...base,
    };
  }
  if (/\b(closer|wider|zoom|close-?up|wide shot|framing|frame|reframe)\b/.test(t)) {
    const shot = /close-?up|closer|zoom in/.test(t) ? "close" : /wide|zoom out|wider/.test(t) ? "wide" : "medium";
    return { tool: "studio.set_camera", args: { shot, confirm: /confirm/.test(t) }, ...base };
  }
  if (/\b(focus|sharp|blurry|soft)\b/.test(t)) {
    const focus = /hands/.test(t) ? "hands" : /product|object|item|screen/.test(t) ? "product" : "face";
    return { tool: "studio.set_camera", args: { focus, confirm: /confirm/.test(t) }, ...base };
  }
  if (/\b(volume|gain|louder|quieter|noisy|noise|hiss|level|clip(?:ping)?)\b/.test(t)) {
    const db = Number(t.match(/([+-]?\d{1,2})\s*db/)?.[1]);
    const adjustDb = Number.isFinite(db) ? db : /louder/.test(t) ? 3 : /quieter|lower/.test(t) ? -3 : undefined;
    const noiseGate = /noise gate on|kill the (hiss|noise|fan)|gate on/.test(t) ? true : /gate off/.test(t) ? false : undefined;
    return { tool: "studio.set_audio", args: { adjustDb, noiseGate }, ...base };
  }
  if (/\b(gold|highlight|keep (this|that)|that was good|that one's good)\b/.test(t)) {
    const label = utterance
      .replace(/^.*?\b(?:gold|highlight|keep)\b/i, "")
      .replace(/^(this|that|it)\b\s*/i, "")
      .replace(/^[,.\s]+/, "")
      .trim();
    return { tool: "studio.highlight", args: { label: label || "the moment that landed" }, ...base };
  }
  if (/\b(cue|marker|mark (this|that))\b/.test(t)) {
    const label = utterance.replace(/^.*?\b(?:mark|add|drop)\b/i, "").replace(/^(a |the )?(cue|marker)\b/i, "").trim();
    return { tool: "studio.mark_cue", args: { label: label || "highlight" }, ...base };
  }
  if (/\b(scene|shot|switch|window|close-?up)\b/.test(t)) {
    const scene = (["intro", "main", "broll", "outro"] as SceneId[]).find((s) => t.includes(s));
    const broll = /b-?roll/i.test(t);
    return { tool: "studio.switch_scene", args: { scene: scene ?? (broll ? "broll" : "main"), confirm: /confirm/.test(t) }, ...base };
  }
  if (
    /\b(light|lighting|brighter|darker|dimmer|exposure|white balance)\b/.test(t) ||
    /\b(warm|cool)\b/.test(t)
  ) {
    const key = parseLevel(t);
    const adjust = adjustLevel(t);
    const temperature = /warm/.test(t) ? "warm" : /cool|cold|blue/.test(t) ? "cool" : undefined;
    if (key === undefined && adjust === undefined && temperature === undefined) {
      // "make it brighter" without a number still does something sensible.
      return { tool: "studio.set_lighting", args: { adjust: 10, confirm: /confirm/.test(t) }, ...base };
    }
    return { tool: "studio.set_lighting", args: { key, adjust: key === undefined ? adjust : undefined, temperature, confirm: /confirm/.test(t) }, ...base };
  }
  if (/\b(run ?sheet|script|outline|structure|plan)\b/.test(t)) {
    const topic = utterance.replace(/^.*?\b(?:about|for|on)\b/i, "").trim() || utterance;
    const minutes = Number(t.match(/(\d{1,3})\s*min/)?.[1] ?? 8);
    return { tool: "studio.suggest_sections", args: { topic, targetMinutes: minutes }, ...base };
  }
  return { tool: "studio.get_status", args: {}, ...base };
}

/** Execute a routed utterance against the live driver. Returns the tool result. */
export function executeRouted(driver: StudioDriver, routed: Routed): ToolResult {
  const ctx = { driver, mode: "live" as const };
  const a = routed.args;
  switch (routed.tool) {
    case "studio.start_recording":
      return startRecording(ctx, { scene: a.scene as SceneId | undefined, dryRun: a.dryRun as boolean | undefined });
    case "studio.stop_recording":
      return stopRecording(ctx, { confirm: a.confirm as boolean | undefined });
    case "studio.switch_scene":
      return switchScene(ctx, { scene: a.scene as SceneId, confirm: a.confirm as boolean | undefined });
    case "studio.set_lighting":
      return setLighting(ctx, {
        key: a.key as number | undefined,
        adjust: a.adjust as number | undefined,
        temperature: a.temperature as "warm" | "neutral" | "cool" | undefined,
        confirm: a.confirm as boolean | undefined,
      });
    case "studio.run_checks":
      return runChecks(ctx);
    case "studio.mark_cue":
      return markCue(ctx, { label: String(a.label) });
    case "studio.suggest_sections":
      return suggestSections(ctx, { topic: String(a.topic), targetMinutes: a.targetMinutes as number });
    case "studio.start_restream":
      return startRestream(ctx, { platforms: a.platforms as string[] | undefined, confirm: a.confirm as boolean | undefined });
    case "studio.stop_restream":
      return stopRestream(ctx, { confirm: a.confirm as boolean | undefined });
    case "studio.set_microphone":
      return setMicrophone(ctx, { muted: Boolean(a.muted) });
    case "studio.set_camera":
      return setCamera(ctx, {
        shot: a.shot as ShotId | undefined,
        focus: a.focus as FocusId | undefined,
        confirm: a.confirm as boolean | undefined,
      });
    case "studio.set_audio":
      return setAudio(ctx, {
        gainDb: a.gainDb as number | undefined,
        adjustDb: a.adjustDb as number | undefined,
        noiseGate: a.noiseGate as boolean | undefined,
        muted: a.muted as boolean | undefined,
      });
    case "studio.next_line":
      return nextLine(ctx, { back: a.back as boolean | undefined, repeat: a.repeat as boolean | undefined });
    case "studio.set_teleprompter_speed":
      return setTeleprompterSpeed(ctx, {
        wpm: a.wpm as number | undefined,
        faster: a.faster as boolean | undefined,
        slower: a.slower as boolean | undefined,
      });
    case "studio.retake":
      return retake(ctx, { reason: a.reason as string | undefined, fromLine: a.fromLine as number | undefined });
    case "studio.highlight":
      return highlight(ctx, { label: String(a.label) });
    default:
      return getStatus(ctx);
  }
}

/** Few-shot examples reused as an MCP prompt for any host model. */
export const ROUTING_EXAMPLES = [
  ["what's the studio looking like", "studio.get_status", {}],
  ["do a dry run", "studio.start_recording", { dryRun: true }],
  ["roll a take on the intro scene", "studio.start_recording", { scene: "intro" }],
  ["that's a wrap", "studio.stop_recording", {}],
  ["mark that, the best take of the hook", "studio.mark_cue", { label: "the best take of the hook" }],
  ["switch to b-roll", "studio.switch_scene", { scene: "broll" }],
  ["a bit darker", "studio.set_lighting", { adjust: -10 }],
  ["key light to 80 percent, warm", "studio.set_lighting", { key: 80, temperature: "warm" }],
  ["give me a close-up", "studio.set_camera", { shot: "close" }],
  ["pull focus to my hands", "studio.set_camera", { focus: "hands" }],
  ["a bit louder, three db", "studio.set_audio", { adjustDb: 3 }],
  ["kill the fan noise", "studio.set_audio", { noiseGate: true }],
  ["next line", "studio.next_line", {}],
  ["slower please", "studio.set_teleprompter_speed", { slower: true }],
  ["cut, take it again", "studio.retake", {}],
  ["that was gold, keep it", "studio.highlight", { label: "keep it" }],
  ["make me a run sheet for unboxing the new mic, 6 minutes", "studio.suggest_sections", { topic: "unboxing the new mic", targetMinutes: 6 }],
  ["go live on youtube", "studio.start_restream", { platforms: ["YouTube"] }],
  ["stop the stream", "studio.stop_restream", {}],
  ["mute the mic", "studio.set_microphone", { muted: true }],
  ["am I ready to record", "studio.run_checks", {}],
] as const;

export { isScene } from "./actions.ts";
