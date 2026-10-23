import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioDriver, initialState } from "../src/core/studio.ts";
import { highlight, retake, suggestSections, draftPublish, nextLine } from "../src/core/actions.ts";
import { buildStudioPackage, keywords, packageToMarkdown } from "../src/core/handoff.ts";
import { routeUtterance } from "../src/core/router.ts";

test("keywords keep the meaty words and drop filler", () => {
  const words = keywords(["make me a run sheet for unboxing the new mic, 6 minutes"]);
  assert.ok(words.includes("unboxing"));
  assert.ok(words.includes("mic"));
  assert.ok(!words.includes("the"));
  assert.ok(!words.includes("make"));
});

test("the publish package is built from what was actually marked", () => {
  const driver = new StudioDriver();
  const ctx = { driver, mode: "live" as const };
  suggestSections(ctx, { topic: "unboxing the new mic", targetMinutes: 6 });
  nextLine(ctx, {});
  driver.getState().recording.elapsedSec = 42;
  retake(ctx, { reason: "flubbed the setup line" });
  driver.getState().recording.elapsedSec = 96;
  highlight(ctx, { label: "the noise gate demo" });

  const pkg = buildStudioPackage(driver.getState());
  assert.match(pkg.title, /Unboxing The New Mic/);
  assert.ok(pkg.chapters.some((c) => /Retake/.test(c.label)), "retakes become chapters");
  assert.ok(pkg.chapters.some((c) => /noise gate demo/.test(c.label)), "highlights become chapters");
  assert.ok(pkg.description.includes("Moments I kept"));
  assert.ok(pkg.hashtags.length > 0 && pkg.hashtags.every((h) => h.startsWith("#")));
  assert.match(pkg.editorialPrompt, /Protect these moments/);
  assert.match(pkg.filename, /^creatorstudio-editor-package-\d{4}-\d{2}-\d{2}\.md$/);
});

test("chapters are de-duplicated within a 3 second window", () => {
  const state = initialState();
  state.recording.elapsedSec = 10;
  state.retakes.push({ line: 1, atSec: 10, reason: "a" });
  state.highlights.push({ id: "hl-1", label: "b", atSec: 11, scene: "main", createdAt: "" });
  state.cues.push({ id: "cue-1", label: "c", atSec: 40, scene: "main", createdAt: "" });
  const pkg = buildStudioPackage(state);
  assert.equal(pkg.chapters.filter((c) => c.atSec < 20).length, 1);
  assert.equal(pkg.chapters.length, 2);
});

test("a take with no marks still produces a usable package", () => {
  const pkg = buildStudioPackage(initialState());
  assert.ok(pkg.title.length > 0);
  assert.ok(pkg.description.includes("Recorded with CreatorStudio"));
  assert.equal(pkg.chapters.length, 1);
  assert.match(packageToMarkdown(pkg), /## Prompt for an AI editor/);
});

test("draft_publish stores the draft on the state and returns markdown", () => {
  const driver = new StudioDriver();
  const ctx = { driver, mode: "live" as const };
  const r = draftPublish(ctx);
  assert.equal(r.ok, true);
  assert.match(r.speech, /drafted from what you actually said/);
  assert.ok(driver.getState().drafts?.title);
  assert.match(String((r.data as any).markdown), /Paste-ready description/);
});

test("router: 'draft me a title and description' hits the handoff tool", () => {
  assert.equal(routeUtterance("draft me a title and description").tool, "studio.draft_publish");
  assert.equal(routeUtterance("build the editor package").tool, "studio.draft_publish");
});
