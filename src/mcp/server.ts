/**
 * The MCP surface of CreatorStudio.
 *
 * Exposes the studio as an Alexa+ add-on tool set over MCP (Streamable HTTP,
 * spec 2025-11-25+). Every tool returns:
 *   - a short, speech-friendly sentence in `content` (what Alexa+ says), and
 *   - structured data in `structuredContent` (what the display/card renders).
 *
 * Tools are deliberately keyword-free and latency-bounded: no long-running
 * work happens inside a tool call, which keeps round trips under Alexa+'s
 * sub-500ms budget.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ToolResult,
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
import { ROUTING_EXAMPLES } from "../core/router.ts";
import type { StudioDriver } from "../core/studio.ts";

export const SERVER_NAME = "creator-studio";
export const SERVER_VERSION = "1.0.0";

export function toolResultToMcp(r: ToolResult) {
  return {
    content: [{ type: "text" as const, text: r.speech }],
    structuredContent: r.data,
    isError: !r.ok,
  };
}

export function createStudioServer(options: { driver: StudioDriver; mode?: "dry_run" | "live" }) {
  const { driver } = options;
  // SAFETY: live drivers (OBS / Elgato / Restream) are opt-in. Default is a
  // dry run so a mis-recognised command never takes a studio off air.
  const mode = options.mode ?? ((process.env.STUDIO_MODE as "dry_run" | "live") || "dry_run");
  const ctx = () => ({ driver, mode });

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "CreatorStudio",
      description:
        "Hands-free voice control plane for a solo video creator's studio: recording, scenes, lighting, cues, run sheets and go-live safety.",
    },
    {
      capabilities: { tools: {} },
      instructions:
        "CreatorStudio controls a one-person video studio. Prefer studio.get_status before any destructive action. " +
        "During a live stream, destructive actions require confirm=true. Keep spoken replies to one short sentence.",
    },
  );

  server.registerPrompt(
    "creatorstudio.plan_utterance",
    {
      title: "Plan a studio utterance",
      description:
        "Few-shot mapping from natural creator speech to the right studio.* tool call. Hosts can drop this into their system prompt.",
      argsSchema: {
        utterance: z.string().describe("What the creator just said"),
      },
    },
    async ({ utterance }) => {
      const examples = ROUTING_EXAMPLES.map(
        ([u, tool, args]) => `- "${u}" -> ${tool}(${JSON.stringify(args)})`,
      ).join("\n");
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                "You route a solo video creator's spoken commands to CreatorStudio MCP tools.\n" +
                "Rules: keep replies to one short spoken sentence; always call studio.get_status before a destructive action; " +
                "during a live stream pass confirm=true only when the creator explicitly confirmed.\n\n" +
                `Examples:\n${examples}\n\nRoute this utterance now: "${utterance}"`,
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    "studio.get_status",
    {
      title: "Get studio status",
      description: "Read recording state, current scene, lighting, microphone and stream status in one call.",
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => toolResultToMcp(getStatus(ctx())),
  );

  server.registerTool(
    "studio.start_recording",
    {
      title: "Start recording",
      description:
        "Start a recording take. Supports dryRun=true for a pre-flight check that does not roll camera.",
      inputSchema: {
        scene: z.enum(["intro", "main", "broll", "outro"]).optional().describe("Scene to record on"),
        title: z.string().max(120).optional().describe("Working title of the take"),
        dryRun: z.boolean().optional().describe("Check everything without starting the take"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => toolResultToMcp(startRecording(ctx(), args)),
  );

  server.registerTool(
    "studio.stop_recording",
    {
      title: "Stop recording",
      description: "Stop the current take and save the file. Requires confirm=true while live.",
      inputSchema: {
        confirm: z.boolean().optional().describe("Explicit confirmation, required while live"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (args) => toolResultToMcp(stopRecording(ctx(), args)),
  );

  server.registerTool(
    "studio.switch_scene",
    {
      title: "Switch scene",
      description:
        "Switch the camera scene (intro/main/broll/outro) and set the recommended key-light level for that shot.",
      inputSchema: {
        scene: z.enum(["intro", "main", "broll", "outro"]),
        preserveLighting: z.boolean().optional().describe("Keep the current lighting level"),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => toolResultToMcp(switchScene(ctx(), args)),
  );

  server.registerTool(
    "studio.set_lighting",
    {
      title: "Set lighting",
      description: "Set key-light level (0-100) and/or colour temperature. Use adjust for relative changes.",
      inputSchema: {
        key: z.number().min(0).max(100).optional(),
        adjust: z.number().min(-100).max(100).optional().describe("Relative change, e.g. -10 for 'a bit darker'"),
        temperature: z.enum(["warm", "neutral", "cool"]).optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => toolResultToMcp(setLighting(ctx(), args)),
  );

  server.registerTool(
    "studio.run_checks",
    {
      title: "Run pre-flight checks",
      description: "Check lights, microphone, disk space and cameras before rolling.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => toolResultToMcp(runChecks(ctx())),
  );

  server.registerTool(
    "studio.mark_cue",
    {
      title: "Mark a cue",
      description: "Drop a timestamped highlight marker into the current take for the editor.",
      inputSchema: {
        label: z.string().min(1).max(80).describe("Short label, e.g. 'best take'"),
        note: z.string().max(400).optional(),
      },
    },
    async (args) => toolResultToMcp(markCue(ctx(), args)),
  );

  server.registerTool(
    "studio.suggest_sections",
    {
      title: "Build a run sheet",
      description: "Turn a topic into a timed run sheet with beats for a target video length.",
      inputSchema: {
        topic: z.string().min(1).max(200),
        targetMinutes: z.number().min(1).max(120).optional(),
        tone: z.enum(["tutorial", "vlog", "review"]).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => toolResultToMcp(suggestSections(ctx(), args)),
  );

  server.registerTool(
    "studio.start_restream",
    {
      title: "Go live",
      description: "Start a simulcast to streaming platforms. Warns if no take is running.",
      inputSchema: {
        platforms: z.array(z.string().max(40)).optional().describe("e.g. ['YouTube', 'Twitch']"),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => toolResultToMcp(startRestream(ctx(), args)),
  );

  server.registerTool(
    "studio.stop_restream",
    {
      title: "End the stream",
      description: "Stop the simulcast. Requires confirm=true while live.",
      inputSchema: { confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => toolResultToMcp(stopRestream(ctx(), args)),
  );

  server.registerTool(
    "studio.set_microphone",
    {
      title: "Mute or unmute microphone",
      description: "Toggle the microphone feed.",
      inputSchema: { muted: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => toolResultToMcp(setMicrophone(ctx(), args)),
  );

  /* ------------- the "crew" tools: one voice, five roles ------------- */

  server.registerTool(
    "studio.set_camera",
    {
      title: "Move the camera (cameraman + focus puller)",
      description:
        "Changes framing (wide / medium / close-up) and focus (face / hands / product) without standing up. " +
        "On OBS this cuts to the matching 'Camera <Shot>' scene preset.",
      inputSchema: {
        shot: z.enum(["wide", "medium", "close"]).optional().describe("Framing, e.g. close for a close-up"),
        focus: z.enum(["face", "hands", "product"]).optional().describe("Where the focus should sit"),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => toolResultToMcp(setCamera(ctx(), args)),
  );

  server.registerTool(
    "studio.set_audio",
    {
      title: "Adjust audio (noise engineer)",
      description:
        "Set mic gain in dB (absolute or relative) and toggle the noise gate — replaces 'can you hear me, is the level right?'",
      inputSchema: {
        gainDb: z.number().min(-24).max(12).optional(),
        adjustDb: z.number().min(-24).max(24).optional().describe("Relative change, e.g. 3 for 'a bit louder'"),
        noiseGate: z.boolean().optional(),
        muted: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => toolResultToMcp(setAudio(ctx(), args)),
  );

  server.registerTool(
    "studio.next_line",
    {
      title: "Advance the teleprompter",
      description:
        "Move the prompter to the next script line (or back / repeat). Returns the line to speak, so a hands-free " +
        "creator never has to look at a screen.",
      inputSchema: {
        back: z.boolean().optional(),
        repeat: z.boolean().optional().describe("Say the current line again"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => toolResultToMcp(nextLine(ctx(), args)),
  );

  server.registerTool(
    "studio.set_teleprompter_speed",
    {
      title: "Pace the teleprompter (director)",
      description: "Set the prompter scroll speed in words per minute, or nudge it faster / slower.",
      inputSchema: {
        wpm: z.number().min(80).max(220).optional(),
        faster: z.boolean().optional(),
        slower: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => toolResultToMcp(setTeleprompterSpeed(ctx(), args)),
  );

  server.registerTool(
    "studio.retake",
    {
      title: "Cut and take it again",
      description:
        "Marks a retake at the current second and jumps the prompter back to that line — 'cut, take it again' " +
        "without stopping the camera or losing the take.",
      inputSchema: {
        reason: z.string().max(120).optional(),
        fromLine: z.number().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => toolResultToMcp(retake(ctx(), args)),
  );

  server.registerTool(
    "studio.highlight",
    {
      title: "Save a highlight",
      description: "Marks a moment that must survive the edit, even if the line gets re-shot.",
      inputSchema: { label: z.string().min(1).max(80) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => toolResultToMcp(highlight(ctx(), args)),
  );

  return server;
}
