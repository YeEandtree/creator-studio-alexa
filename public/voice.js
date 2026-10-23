// ?voice=1 — a deterministic "the creator spoke" replay.
// The text input stays empty: every line is injected the same way the Web Speech
// API hands it to the page (final transcript), so the visual path is identical to
// real speech recognition, while the recording never depends on a live mic.
const LINES = [
  ["what’s the studio looking like", 900],
  ["give me a close-up", 900],
  ["pull focus to my hands", 900],
  ["a bit darker", 800],
  ["set white balance warm", 800],
  ["a bit louder", 800],
  ["kill the fan noise", 800],
  ["make me a run sheet for unboxing the new mic, 6 minutes", 1300],
  ["roll a take on the intro scene", 1300],
  ["next line", 900],
  ["slower please", 900],
  ["cut, take it again", 1200],
  ["that was gold, and it lands", 1200],
  ["go live on youtube", 1300],
  ["stop the stream", 1800],
  ["stop the stream, confirm", 1500],
  ["draft me a title and description", 1500],
];

const CAPTIONS = [
  ["01 MIC", "The microphone is the control surface."],
  ["02 CAMERAMAN", "Camera + focus, without leaving the frame."],
  ["03 LIGHTING", "Lighting tech."],
  ["04 SOUND", "Sound engineer."],
  ["05 PROMPTER", "Run sheet goes straight to the teleprompter."],
  ["06 DIRECTOR", "Cut, take it again — the take keeps rolling."],
  ["07 SAFETY", "Live stream: the server refuses to go off air on a guess."],
  ["08 HANDOFF", "Title, chapters, retakes — one download for the editor."],
];

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStrip(text, active = false) {
  const strip = $("voice-strip");
  if (!strip) return;
  strip.hidden = false;
  strip.classList.toggle("active", active);
  $("vs-text").innerHTML = text;
}

function setBubble(text) {
  const bubble = $("heard");
  const t = $("heard-text");
  if (!bubble || !t) return;
  t.textContent = text || "…";
  bubble.classList.add("show");
}

function setCaption(step, text) {
  const bar = $("caption-bar");
  $("cap-step").textContent = step;
  $("cap-text").textContent = text;
  bar.classList.remove("flash");
  void bar.offsetWidth;
  bar.classList.add("flash");
}

/** Inject a finished utterance (what SpeechRecognition.onend would hand over). */
function hear(utterance) {
  const input = $("input");
  input.value = utterance;
  $("hint").textContent = `hearing: ${utterance}`;
  setBubble(utterance);
}

async function run() {
  await fetch("/api/reset", { method: "POST" });
  $("voice-strip").hidden = false;
  setStrip("<b>listening…</b> say a command", false);
  setCaption("00 READY", "CreatorStudio · hands-free studio control");
  await sleep(1400);

  let i = 0;
  for (const [utterance, hold] of LINES) {
    // caption follows the role that is about to do the work
    if (i === 0) setCaption(...CAPTIONS[0]);
    if (i === 2) setCaption(...CAPTIONS[1]);
    if (i === 3) setCaption(...CAPTIONS[2]);
    if (i === 5) setCaption(...CAPTIONS[3]);
    if (i === 7) setCaption(...CAPTIONS[4]);
    if (i === 9) setCaption(...CAPTIONS[5]);
    if (i === 13) setCaption(...CAPTIONS[6]);
    if (i === 16) setCaption(...CAPTIONS[7]);

    const orb = $("orb");
    orb.dataset.state = "listening";
    $("mic-btn").classList.add("listening");
    setStrip(`<b>listening…</b> ${utterance}`, true);
    await sleep(420);
    hear(utterance);
    await sleep(260);
    orb.dataset.state = "thinking";
    $("mic-btn").classList.remove("listening");
    setStrip(`<b>heard</b> “${utterance}” · calling a tool`, false);

    $("input").form.requestSubmit();
    await sleep(hold);

    // the reply card is cleared by send(); keep the mic line for the next turn
    hear("");
    await sleep(260);
  }

  $("orb").dataset.state = "idle";
  setStrip("<b>done.</b> 18 typed tools · every call above is real", false);
  const bar = $("caption-bar");
  $("cap-step").textContent = "09 END";
  $("cap-text").textContent = "CreatorStudio · github.com/YeEandtree/creator-studio-alexa";
  bar.classList.remove("flash");
  void bar.offsetWidth;
  bar.classList.add("flash");
  setTimeout(() => {
    const b = $("heard");
    if (b) b.classList.remove("show");
  }, 1200);
  i = i;
}

if (new URLSearchParams(location.search).has("voice") || location.pathname.endsWith("/voice")) {
  run();
}
