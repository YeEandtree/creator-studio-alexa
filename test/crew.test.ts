import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioDriver, initialState } from "../src/core/studio.ts";
import {
  nextLine,
  retake,
  setAudio,
  setCamera,
  setTeleprompterSpeed,
  highlight,
  suggestSections,
} from "../src/core/actions.ts";
import { routeUtterance } from "../src/core/router.ts";

const ctxOf = () => {
  const driver = new StudioDriver();
  return { driver, ctx: { driver, mode: "live" as const } };
};

test("cameraman: shot and focus change in one call", () => {
  const { driver, ctx } = ctxOf();
  const r = setCamera(ctx, { shot: "close", focus: "hands" });
  assert.equal(r.ok, true);
  assert.match(r.speech, /close-up/);
  assert.match(r.speech, /your hands/);
  assert.deepEqual(driver.getState().camera, { shot: "close", focus: "hands" });
});

test("noise engineer: relative gain is clamped and warns near clipping", () => {
  const { driver, ctx } = ctxOf();
  setAudio(ctx, { gainDb: 0 });
  const louder = setAudio(ctx, { adjustDb: 3 });
  assert.match(louder.speech, /plus 3 dB/);
  assert.equal(driver.getState().audio.gainDb, 3);
  const hot = setAudio(ctx, { gainDb: 11 });
  assert.match(hot.speech, /clipping/);
  const clamp = setAudio(ctx, { gainDb: 99 });
  assert.equal(driver.getState().audio.gainDb, 12, "clamped to the top of the safe range");
});

test("teleprompter: next, back and repeat walk the script", () => {
  const { driver, ctx } = ctxOf();
  assert.equal(initialState().teleprompter.line, 1);
  const second = nextLine(ctx, {});
  assert.match(second.speech, /Line 2 of 6/);
  assert.equal(driver.getState().teleprompter.line, 2);
  nextLine(ctx, { back: true });
  assert.equal(driver.getState().teleprompter.line, 1);
  const repeat = nextLine(ctx, { repeat: true });
  assert.match(repeat.speech, /Repeating line 1/);
});

test("a run sheet is loaded straight onto the teleprompter", () => {
  const { driver, ctx } = ctxOf();
  suggestSections(ctx, { topic: "unboxing the new mic", targetMinutes: 6 });
  const tp = driver.getState().teleprompter;
  assert.equal(tp.line, 1);
  assert.equal(tp.lines.length, 6);
  assert.equal(tp.topic, "unboxing the new mic");
});

test("pacing: faster / slower keep the prompter inside a human range", () => {
  const { driver, ctx } = ctxOf();
  setTeleprompterSpeed(ctx, { faster: true });
  assert.equal(driver.getState().teleprompter.speedWpm, 160);
  setTeleprompterSpeed(ctx, { wpm: 500 });
  assert.equal(driver.getState().teleprompter.speedWpm, 220);
});

test("director: retake marks the second and rewinds the prompter, recording untouched", () => {
  const { driver, ctx } = ctxOf();
  driver.getState().recording.elapsedSec = 47;
  nextLine(ctx, {});
  nextLine(ctx, {});
  const r = retake(ctx, { reason: "flubbed the intro" });
  assert.match(r.speech, /0:47/);
  assert.equal(driver.getState().retakes.length, 1);
  assert.equal(driver.getState().retakes[0].atSec, 47);
  assert.equal(driver.getState().retakes[0].line, 3);
  assert.equal(driver.getState().teleprompter.line, 3, "prompter waits on the same line");
});

test("highlights survive a retake — the editor keeps them", () => {
  const { driver, ctx } = ctxOf();
  driver.getState().recording.elapsedSec = 12;
  highlight(ctx, { label: "the hook" });
  retake(ctx, {});
  driver.reset();
  const d2 = new StudioDriver();
  const c2 = { driver: d2, mode: "live" as const };
  d2.getState().recording.elapsedSec = 5;
  highlight(c2, { label: "gold" });
  d2.getState().recording.elapsedSec = 30;
  retake(c2, {});
  assert.equal(d2.getState().highlights.length, 1);
  assert.equal(d2.getState().highlights[0].atSec, 5);
});

test("router understands the vocabulary of a real solo creator", () => {
  const cases: [string, string][] = [
    ["give me a close-up", "studio.set_camera"],
    ["pull focus to my hands", "studio.set_camera"],
    ["a bit louder", "studio.set_audio"],
    ["kill the fan noise", "studio.set_audio"],
    ["next line", "studio.next_line"],
    ["go back a line", "studio.next_line"],
    ["slower please", "studio.set_teleprompter_speed"],
    ["cut, take it again", "studio.retake"],
    ["that was gold, keep it", "studio.highlight"],
  ];
  for (const [sentence, tool] of cases) {
    assert.equal(routeUtterance(sentence).tool, tool, sentence);
  }
  assert.equal(routeUtterance("give me a close-up").args.shot, "close");
  assert.equal(routeUtterance("pull focus to my hands").args.focus, "hands");
  assert.equal(routeUtterance("slower please").args.slower, true);
});
