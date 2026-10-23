/**
 * CreatorStudio shared types.
 *
 * The studio is modelled as a tiny state machine so every MCP tool call is
 * idempotent-ish and auditable: each tool reads the current state, validates a
 * guard, mutates, and appends to an action journal that the web simulator renders.
 */

export type SceneId = "intro" | "main" | "broll" | "outro";

export type StudioAction =
  | "start_recording"
  | "stop_recording"
  | "pause_recording"
  | "resume_recording"
  | "mark_cue"
  | "switch_scene"
  | "set_lighting"
  | "mute_audio"
  | "unmute_audio"
  | "start_restream"
  | "stop_restream"
  | "whisper";

export type StudioState = {
  /** ISO timestamp of the last state change. */
  updatedAt: string;
  recording: {
    status: "idle" | "recording" | "paused";
    /** Seconds recorded so far (mock OBS takes). */
    elapsedSec: number;
    take: number;
    lastFile: string | null;
    startedAt: string | null;
  };
  scene: SceneId;
  lighting: {
    /** 0-100, relative to the key light ceiling for the current scene. */
    key: number;
    /** Warm / neutral / cool. */
    temperature: "warm" | "neutral" | "cool";
  };
  audio: { muted: boolean };
  restream: { live: boolean; startedAt: string | null };
  cues: { id: string; label: string; atSec: number; scene: SceneId; createdAt: string }[];
};

export type GuardLevel = "ok" | "warn" | "block";

export type GuardIssue = {
  level: GuardLevel;
  code: string;
  message: string;
  fix?: string;
};

export type ActionLogEntry = {
  id: string;
  at: string;
  /** Tool name exposed over MCP, e.g. studio.start_recording */
  tool: string;
  action: StudioAction;
  summary: string;
  detail?: Record<string, unknown>;
  ok: boolean;
  latencyMs: number;
  mode: "dry_run" | "live";
  /** Alexa-friendly sentence returned to the model as the speech payload. */
  speech: string;
  /** Rich card payload rendered by the simulator (Alexa+ display modes). */
  card?: RichCard;
};

export type RichCard =
  | { type: "status"; title: string; rows: { label: string; value: string }[] }
  | { type: "checklist"; title: string; items: { ok: boolean; label: string }[] }
  | { type: "timeline"; title: string; cues: { label: string; atSec: number; scene: SceneId }[] }
  | { type: "script"; title: string; sections: { heading: string; atSec: number; text: string }[] };

export type RunSheet = {
  title: string;
  targetMinutes: number;
  sections: { heading: string; atSec: number; text: string }[];
};
