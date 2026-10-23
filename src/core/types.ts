/**
 * CreatorStudio shared types.
 *
 * The studio is modelled as a tiny state machine so every MCP tool call is
 * idempotent-ish and auditable: each tool reads the current state, validates a
 * guard, mutates, and appends to an action journal that the web simulator renders.
 */

export type SceneId = "intro" | "main" | "broll" | "outro";

/** Camera framing the "camera operator" switches to. */
export type ShotId = "wide" | "medium" | "close";

/** Where the camera focuses — the "focus puller". */
export type FocusId = "face" | "hands" | "product";

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
  | "whisper"
  | "set_camera"
  | "set_focus"
  | "next_line"
  | "teleprompter_speed"
  | "set_audio"
  | "retake"
  | "highlight_cue";

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
  audio: { muted: boolean; gainDb: number; noiseGate: boolean };
  /** The "camera operator": framing + focus. */
  camera: { shot: ShotId; focus: FocusId };
  /** The "teleprompter": the script line currently on the glass. */
  teleprompter: {
    topic: string;
    lines: string[];
    /** 1-based index of the line on screen. */
    line: number;
    visible: boolean;
    speedWpm: number;
  };
  /** "Cut, take it again" marks, kept so the editor can rebuild the take. */
  retakes: { line: number; atSec: number; reason: string }[];
  /** Saved highlight moments (the cue list survives a retake). */
  highlights: { id: string; label: string; atSec: number; scene: SceneId; createdAt: string }[];
  /**
   * Titles, tags and captions drafted from what was actually said on the take.
   * Kept on the state so the "editor's inbox" can show them.
   */
  drafts?: {
    title: string;
    description: string;
    hashtags: string[];
    chapters: { atSec: number; label: string }[];
  } | null;
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
