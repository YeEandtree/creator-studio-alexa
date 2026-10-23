/**
 * CreatorStudio state + safety guard.
 *
 * Design intent: a voice-first studio assistant must be *fast* (Alexa+ wants
 * low-latency tool round-trips) and *safe* (a mis-heard word must never publish
 * a live stream). Everything here is pure/synchronous so guard checks stay in
 * the sub-10ms range and can be unit tested without a network.
 */

import { randomUUID } from "node:crypto";
import type { LiveDriver } from "../drivers/obs.ts";
import type {
  ActionLogEntry,
  GuardIssue,
  RichCard,
  RunSheet,
  SceneId,
  StudioAction,
  StudioState,
} from "./types.ts";

export const SCENES: SceneId[] = ["intro", "main", "broll", "outro"];

/** Recommended key-light level per scene (0-100). */
export const SCENE_LIGHTS: Record<SceneId, number> = {
  intro: 72,
  main: 62,
  broll: 45,
  outro: 68,
};

/** Default script lines, so "next line" works before a run sheet exists. */
export const DEFAULT_SCRIPT: { heading: string; text: string }[] = [
  { heading: "Cold open", text: "By the end of this video you'll know exactly how to set up the new mic." },
  { heading: "Who this is for", text: "If you record alone and you're tired of getting up to change settings, this is for you." },
  { heading: "First result", text: "Here's the finished setup running — now let me show you how it got there." },
  { heading: "The hard part", text: "This is the step where most people quit. Watch the levels here." },
  { heading: "Payoff", text: "That's the difference. Same voice, half the noise." },
  { heading: "Call to action", text: "If this saved you a re-shoot, subscribe — next week I do the camera swap." },
];

export function initialState(now = new Date()): StudioState {
  return {
    updatedAt: now.toISOString(),
    recording: { status: "idle", elapsedSec: 0, take: 1, lastFile: null, startedAt: null },
    scene: "main",
    lighting: { key: SCENE_LIGHTS.main, temperature: "neutral" },
    audio: { muted: false, gainDb: 0, noiseGate: true },
    camera: { shot: "medium", focus: "face" },
    teleprompter: {
      topic: "untitled take",
      lines: DEFAULT_SCRIPT.map((s) => s.text),
      line: 1,
      visible: true,
      speedWpm: 140,
    },
    retakes: [],
    highlights: [],
    restream: { live: false, startedAt: null },
    cues: [],
  };
}

/** Format seconds as mm:ss (or h:mm:ss) for speech output. */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Run the safety guard for an action. Returns issues sorted by severity.
 * Blocking issues stop the action; warnings are surfaced to the host but the
 * action still runs (the caller decides, the guard advises).
 */
export function guard(action: StudioAction, state: StudioState, args: Record<string, unknown> = {}): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const isLive = state.restream.live;
  const isRecording = state.recording.status === "recording";

  if (isLive && action === "start_restream") {
    issues.push({
      level: "block",
      code: "ALREADY_LIVE",
      message: "You are already live. Restarting would drop the stream.",
    });
  }

  if (action === "stop_restream" && !isLive) {
    issues.push({ level: "block", code: "NOT_LIVE", message: "You are not live right now." });
  }

  if (isLive && args.confirm !== true && LIVE_CONFIRM_ACTIONS.has(action)) {
    issues.push({
      level: "block",
      code: "LIVE_NEEDS_CONFIRMATION",
      message: "You are live — this is a destructive action during a broadcast and needs explicit confirmation.",
      fix: "Ask the creator to confirm, then call again with confirm=true.",
    });
  }

  if (action === "start_recording" && state.recording.status !== "idle") {
    issues.push({
      level: "block",
      code: "RECORDING_IN_PROGRESS",
      message: "A take is already running. Stop it first so you do not lose the file.",
    });
  }

  if (action === "start_recording" && state.audio.muted) {
    issues.push({
      level: "warn",
      code: "AUDIO_MUTED",
      message: "Microphone is muted — your take will be silent.",
      fix: "Unmute first.",
    });
  }

  if (action === "mark_cue" && !isRecording) {
    issues.push({ level: "warn", code: "NOT_RECORDING", message: "Cue marked while not recording." });
  }

  if (action === "start_restream" && !isRecording) {
    issues.push({
      level: "warn",
      code: "LIVE_WITHOUT_TAKE",
      message: "Starting the stream without a recording take running — highlights will not be generated.",
    });
  }

  return issues.sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
}

const SEVERITY: Record<GuardIssue["level"], number> = { block: 0, warn: 1, ok: 2 };

/** Actions that need an explicit confirm=true while the stream is live. */
export const LIVE_CONFIRM_ACTIONS = new Set<StudioAction>([
  "stop_recording",
  "switch_scene",
  "set_lighting",
  "stop_restream",
]);

export function blocked(issues: GuardIssue[]): GuardIssue | undefined {
  return issues.find((i) => i.level === "block");
}

/** Deterministic demo run sheet, so the demo does not depend on an LLM. */
export function buildRunSheet(topic: string, targetMinutes: number): RunSheet {
  const t = Math.max(1, Math.round(targetMinutes));
  const seg = (fraction: number) => Math.round(t * 60 * fraction);
  return {
    title: topic,
    targetMinutes: t,
    sections: [
      {
        heading: "Cold open — the promise",
        atSec: 0,
        text: `One sentence on what viewers get in ${t} minutes of "${topic}". No intro music, no "hey guys".`,
      },
      {
        heading: "Setup — who this is for",
        atSec: seg(0.1),
        text: "Name the viewer's situation in 20 seconds, then the outcome you will show.",
      },
      {
        heading: "Body 1 — the first result",
        atSec: seg(0.25),
        text: "Show the finished thing first, then explain how you got there.",
      },
      {
        heading: "Body 2 — the hard part",
        atSec: seg(0.5),
        text: "The step where most people quit. Put your on-screen demo here.",
      },
      {
        heading: "Body 3 — the payoff",
        atSec: seg(0.7),
        text: "Before / after, numbers, or the moment it clicks.",
      },
      {
        heading: "Close — next step",
        atSec: seg(0.9),
        text: "One clear call to action, then stop talking. Trim the tail in post.",
      },
    ],
  };
}

/** Mock "OBS / Elgato / Restream" driver. Swapped for real drivers via env. */
export class StudioDriver {
  private log: ActionLogEntry[] = [];
  private state: StudioState;

  constructor(state: StudioState = initialState()) {
    this.state = state;
  }

  snapshot(): StudioState {
    return structuredClone(this.state);
  }

  journal(): ActionLogEntry[] {
    return [...this.log];
  }

  reset(): StudioState {
    this.state = initialState();
    this.log = [];
    return this.snapshot();
  }

  /**
   * Applied by the MCP tools after guards pass. Returns the journal entry that
   * the simulator UI renders and that MCP returns as structured content.
   */
  apply(input: {
    tool: string;
    action: StudioAction;
    args: Record<string, unknown>;
    mode: "dry_run" | "live";
    speech: string;
    summary: string;
    card?: RichCard;
    mutate?: (state: StudioState) => void;
    latencyMs?: number;
  }): ActionLogEntry {
    const started = Date.now();
    this.state.updatedAt = new Date().toISOString();
    input.mutate?.(this.state);
    const entry: ActionLogEntry = {
      id: randomUUID().slice(0, 8),
      at: this.state.updatedAt,
      tool: input.tool,
      action: input.action,
      summary: input.summary,
      detail: input.args,
      ok: true,
      latencyMs: input.latencyMs ?? Math.max(0, Date.now() - started),
      mode: input.mode,
      speech: input.speech,
      card: input.card,
    };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    return entry;
  }

  /** Record a blocked attempt so the UI can show *why* voice control refused. */
  reject(input: { tool: string; action: StudioAction; speech: string; detail?: Record<string, unknown> }): ActionLogEntry {
    const entry: ActionLogEntry = {
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      tool: input.tool,
      action: input.action,
      summary: "Blocked by safety guard",
      detail: input.detail,
      ok: false,
      latencyMs: 0,
      mode: "dry_run",
      speech: input.speech,
    };
    this.log.push(entry);
    return entry;
  }

  getState(): StudioState {
    return this.state;
  }

  /* ------------------------- hardware driver seam ------------------------ */

  private liveDriver?: LiveDriver;
  private lastDriverOutcome?: { ok: boolean; skipped: boolean; detail: string; latencyMs: number; at: string };

  /**
   * Attach a real hardware driver (OBS today, Elgato / Restream next). Only used
   * when the server runs in `live` mode; dry runs never touch hardware.
   */
  useDriver(driver: LiveDriver): void {
    this.liveDriver = driver;
  }

  get driverName(): string {
    return this.liveDriver?.name ?? "simulator";
  }

  get lastOutcome() {
    return this.lastDriverOutcome;
  }

  /**
   * Fire a driver call. Deliberately NOT awaited before the spoken reply is
   * produced: the driver enforces its own sub-second timeout, and an
   * unreachable device resolves as "skipped" rather than an error.
   */
  dispatch(kind: DispatchKind, arg?: string, arg2?: string): void {
    const driver = this.liveDriver;
    if (!driver) return;
    const run = async () => {
      let outcome;
      if (kind === "start_recording") outcome = await driver.startRecording();
      else if (kind === "stop_recording") outcome = await driver.stopRecording();
      else if (kind === "switch_scene") outcome = await driver.setScene(arg ?? "main");
      else if (driver.setCamera) outcome = await driver.setCamera(arg ?? "medium", arg2 ?? "face");
      else outcome = { ok: true, skipped: true, detail: `${kind}: no driver support`, latencyMs: 0 };
      this.lastDriverOutcome = { ...outcome, at: new Date().toISOString() };
    };
    void run().catch((err: unknown) => {
      this.lastDriverOutcome = { ok: false, skipped: true, detail: String(err), latencyMs: 0, at: new Date().toISOString() };
    });
  }
}

export type DispatchKind = "start_recording" | "stop_recording" | "switch_scene" | "camera" | "retake";
