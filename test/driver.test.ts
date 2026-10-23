import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioDriver } from "../src/core/studio.ts";
import type { DriverOutcome, LiveDriver } from "../src/drivers/obs.ts";
import { startRecording, stopRecording, switchScene, getStatus } from "../src/core/actions.ts";

/** Fake device that records what the studio asked it to do. */
class FakeDevice implements LiveDriver {
  readonly name = "fake-obs";
  calls: string[] = [];
  private out(ok = true): Promise<DriverOutcome> {
    return Promise.resolve({ ok, skipped: !ok, detail: "", latencyMs: 1 });
  }
  startRecording() {
    this.calls.push("StartRecord");
    return this.out();
  }
  stopRecording() {
    this.calls.push("StopRecord");
    return this.out();
  }
  setScene(scene: string) {
    this.calls.push(`SetCurrentProgramScene:${scene}`);
    return this.out();
  }
}

/** Device that never answers — the wall-clock sentinel for the latency budget. */
class HangingDevice implements LiveDriver {
  readonly name = "hanging-obs";
  startRecording(): Promise<DriverOutcome> {
    return new Promise(() => {});
  }
  stopRecording(): Promise<DriverOutcome> {
    return new Promise(() => {});
  }
  setScene(): Promise<DriverOutcome> {
    return new Promise(() => {});
  }
}

test("a live tool call dispatches to the real device without waiting for it", async () => {
  const driver = new StudioDriver();
  const device = new FakeDevice();
  driver.useDriver(device);
  const ctx = { driver, mode: "live" as const };

  const r = startRecording(ctx, { scene: "intro" });
  assert.equal(r.ok, true);
  // The spoken reply comes back before the device finishes.
  assert.match(r.speech, /Rolling/);
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(device.calls, ["StartRecord", "SetCurrentProgramScene:intro"]);

  switchScene(ctx, { scene: "broll" });
  stopRecording(ctx, {});
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(device.calls.slice(2), ["SetCurrentProgramScene:broll", "StopRecord"]);
});

test("a frozen device cannot blow the tool latency budget", async () => {
  const driver = new StudioDriver();
  driver.useDriver(new HangingDevice());
  const ctx = { driver, mode: "live" as const };
  const t0 = performance.now();
  const r = startRecording(ctx, {});
  const elapsed = performance.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(elapsed < 50, `tool returned in ${elapsed.toFixed(1)}ms even though the device hangs`);
});

test("dry run never touches hardware", () => {
  const driver = new StudioDriver();
  const device = new FakeDevice();
  driver.useDriver(device);
  const ctx = { driver, mode: "dry_run" as const };
  startRecording(ctx, {});
  stopRecording(ctx, {});
  switchScene(ctx, { scene: "outro" });
  assert.deepEqual(device.calls, []);
});

test("no driver means the simulator, and status stays honest", () => {
  const driver = new StudioDriver();
  assert.equal(driver.driverName, "simulator");
  const r = getStatus({ driver, mode: "dry_run" });
  assert.equal(r.data.ok, true);
});
