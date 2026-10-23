/**
 * Real hardware driver: OBS Studio over obs-websocket v5.
 *
 * Enable in OBS: Tools → WebSocket Server Settings → Enable WebSocket server
 * (default port 4455), set a password, then run:
 *
 *   STUDIO_MODE=live OBS_URL=ws://127.0.0.1:4455 OBS_PASSWORD=... npm start
 *
 * Design rules that keep Alexa+ happy:
 *   - every OBS call is awaited with a hard timeout (default 400ms) so a frozen
 *     OBS can never blow the tool-call latency budget;
 *   - if OBS is unreachable the call resolves as "skipped" instead of throwing,
 *     so the spoken reply is still useful;
 *   - the driver is only used when STUDIO_MODE=live, so the demo stays safe.
 */

import OBSWebSocket from "obs-websocket-js/json";

export type DriverOutcome = {
  ok: boolean;
  skipped: boolean;
  detail: string;
  latencyMs: number;
};

export type LiveDriver = {
  readonly name: string;
  startRecording(): Promise<DriverOutcome>;
  stopRecording(): Promise<DriverOutcome>;
  setScene(scene: string): Promise<DriverOutcome>;
  /** Sent asynchronously (fire and forget) so it never delays a reply. */
  setLighting?(key: number, temperature: string): Promise<DriverOutcome>;
  /** Optional camera control (PTZ / Elgato Facecam / Cam Link scene presets). */
  setCamera?(shot: string, focus: string): Promise<DriverOutcome>;
};

const OBS_SCENE_NAME: Record<string, string> = {
  intro: "Intro",
  main: "Main",
  broll: "Broll",
  outro: "Outro",
};

function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class ObsDriver implements LiveDriver {
  readonly name = "obs-websocket";
  private obs = new OBSWebSocket();
  private connected = false;
  private readonly url: string;
  private readonly password: string;
  private readonly budgetMs: number;

  constructor(opts?: { url?: string; password?: string; budgetMs?: number }) {
    this.url = opts?.url ?? process.env.OBS_URL ?? "ws://127.0.0.1:4456";
    this.password = opts?.password ?? process.env.OBS_PASSWORD ?? "";
    this.budgetMs = opts?.budgetMs ?? Number(process.env.OBS_TIMEOUT_MS ?? 400);
  }

  private async ensure(): Promise<void> {
    if (this.connected) return;
    await timeout(this.obs.connect(this.url, this.password || undefined), 2000, "obs connect");
    this.connected = true;
  }

  private async call<T>(label: string, fn: () => Promise<T>): Promise<DriverOutcome> {
    const t0 = performance.now();
    try {
      await this.ensure();
      await timeout(fn(), this.budgetMs, label);
      return { ok: true, skipped: false, detail: `${label} ok`, latencyMs: Math.round(performance.now() - t0) };
    } catch (err) {
      // Unreachable / slow OBS must not surface as a tool error: the creator needs
      // a sentence, and the studio state machine stays consistent.
      this.connected = false;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        skipped: true,
        detail: `${label} skipped: ${message}`,
        latencyMs: Math.round(performance.now() - t0),
      };
    }
  }

  startRecording() {
    return this.call("StartRecord", () => this.obs.call("StartRecord"));
  }

  stopRecording() {
    return this.call("StopRecord", () => this.obs.call("StopRecord"));
  }

  setScene(scene: string) {
    const profile = OBS_SCENE_NAME[scene] ?? scene;
    return this.call("SetCurrentProgramScene", () =>
      this.obs.call("SetCurrentProgramScene", { sceneName: profile }),
    );
  }

  setLighting() {
    // OBS has no lighting API; Elgato Key Light is a separate HTTP call (Phase 2).
    return Promise.resolve({ ok: true, skipped: true, detail: "lighting not wired to OBS", latencyMs: 0 });
  }

  /**
   * Camera framing maps onto OBS scene presets ("Camera Wide" / "Camera Close"),
   * so a spoken "closer" really does cut to the close-up source inside OBS.
   * Focus belongs to a PTZ / autofocus driver, not OBS, so it is a no-op here.
   */
  setCamera(shot: string) {
    const preset = `Camera ${shot.charAt(0).toUpperCase()}${shot.slice(1)}`;
    return this.call("SetCurrentProgramScene", () =>
      this.obs.call("SetCurrentProgramScene", { sceneName: preset }),
    );
  }
}

export function describeLiveDriver(options: { obsUrl?: string }): LiveDriver | undefined {
  if (!options.obsUrl) return undefined;
  return new ObsDriver({ url: options.obsUrl });
}
