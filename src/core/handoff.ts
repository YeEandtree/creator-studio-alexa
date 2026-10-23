/**
 * Studio-to-editor handoff: everything the creator said on camera becomes a
 * package the editor (or the creator at 2 a.m.) can paste into YouTube.
 *
 * Everything in here is pure: it composes titles, chapters, hashtags and a
 * prompt from footage that is ALREADY documented by the tools, so it costs no
 * model round-trip and stays inside the latency budget.
 */

import { formatClock } from "./studio.ts";
import type { StudioState } from "./types.ts";

export type StudioPackage = {
  title: string;
  description: string;
  hashtags: string[];
  chapters: { atSec: number; label: string }[];
  retakeList: string[];
  highlightList: string[];
  editorialPrompt: string;
  filename: string;
};

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "to", "of", "on", "in", "my", "me", "i",
  "make", "me", "please", "just", "that", "this", "it", "is", "are", "was",
]);

/** Pull the meaty words out of what the creator said (topics, cue labels). */
export function keywords(texts: string[], limit = 6): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const raw of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5']+/)) {
      const word = raw.trim();
      if (!word || word.length < 3 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([w]) => w);
}

function titleCase(s: string): string {
  // Capitalise only the first letter of each word: no "Week'S" artefacts.
  return s.toLowerCase().replace(/(^|\s)([a-z])/g, (_m, sp, c) => sp + c.toUpperCase());
}

export function buildStudioPackage(state: StudioState): StudioPackage {
  const topic = state.teleprompter.topic && state.teleprompter.topic !== "untitled take"
    ? state.teleprompter.topic
    : "this week's take";
  const hot = keywords([topic, ...state.highlights.map((h) => h.label), ...state.cues.map((c) => c.label)]);
  const core = hot.slice(0, 3).map(titleCase).join(" · ");
  const titleBase = titleCase(topic);
  const hooks = ["I did this alone. Here is how.", "No crew, no editor — still shipped.", "One voice ran the whole shoot."];
  const hook = hooks[(state.retakes.length + state.highlights.length) % hooks.length];
  const title = (core ? `${titleBase} — ${core}` : titleBase).slice(0, 100);

  const chapters = state.retakes.length
    ? state.retakes.map((r, i) => ({ atSec: r.atSec, label: `Retake ${i + 1} — ${r.reason.slice(0, 40)}` }))
    : [{ atSec: 0, label: "Cold open" }];
  for (const c of [...state.cues, ...state.highlights]) {
    chapters.push({ atSec: c.atSec, label: c.label });
  }
  chapters.sort((a, b) => a.atSec - b.atSec);
  const deduped: { atSec: number; label: string }[] = [];
  for (const ch of chapters) {
    if (!deduped.some((d) => Math.abs(d.atSec - ch.atSec) < 3)) deduped.push(ch);
  }

  const description = [
    hook,
    "",
    `Recorded with CreatorStudio — one voice, five jobs: camera, focus, lighting, sound and the teleprompter.`,
    state.highlights.length
      ? `\nMoments I kept:\n${state.highlights.map((h) => `- ${formatClock(h.atSec)} ${h.label}`).join("\n")}`
      : "",
    deduped.length
      ? `\nChapters:\n${deduped.map((c) => `${formatClock(c.atSec)} ${c.label}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const hashtags = hot.slice(0, 5).map((w) => `#${w.replace(/[^a-z0-9]/g, "")}`).filter((h) => h.length > 2);

  const retakeList = state.retakes.map(
    (r) => `${formatClock(r.atSec)} — line ${r.line} — ${r.reason}`,
  );
  const highlightList = state.highlights.map((h) => `${formatClock(h.atSec)} — ${h.label} (${h.scene})`);

  const editorialPrompt = [
    `You are editing the take "${titleBase}".`,
    `Cut everything between a retake mark and the next "NEXT" marker, and reuse the previous try.`,
    state.highlights.length
      ? `Protect these moments even if you re‑cut the timeline: ${state.highlights.map((h) => `${formatClock(h.atSec)} ${h.label}`).join("; ")}.`
      : "No protected moments were marked.",
    state.retakes.length
      ? `Retake positions: ${state.retakes.map((r) => `${formatClock(r.atSec)} (line ${r.line})`).join(", ")}.`
      : "No retakes.",
    `Target pace: ${state.teleprompter.speedWpm} words per minute — that is the pace you actually spoke at.`,
    `Scene order to respect: ${[...new Set([state.scene, ...state.highlights.map((h) => h.scene)])].join(" → ")}.`,
  ].join(" ");

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    title,
    description,
    hashtags,
    chapters: deduped,
    retakeList,
    highlightList,
    editorialPrompt,
    filename: `creatorstudio-editor-package-${stamp}.md`,
  };
}

/** Markdown the creator can drop in the editor's hands (or paste to an AI editor). */
export function packageToMarkdown(pkg: StudioPackage): string {
  return [
    `# ${pkg.title}`,
    "",
    "## Paste-ready description",
    "",
    pkg.description,
    "",
    pkg.hashtags.join(" "),
    "",
    "## Retakes (cut these spans)",
    "",
    pkg.retakeList.length ? pkg.retakeList.map((r) => `- ${r}`).join("\n") : "- none",
    "",
    "## Protected moments (never cut)",
    "",
    pkg.highlightList.length ? pkg.highlightList.map((h) => `- ${h}`).join("\n") : "- none",
    "",
    "## Prompt for an AI editor",
    "",
    pkg.editorialPrompt,
    "",
  ].join("\n");
}
