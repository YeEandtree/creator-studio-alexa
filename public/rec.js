// The recorded version of the demo: driven at human pace, real typing, real
// MCP calls, with a caption bar that names the crew member doing the work.
// Open  http://localhost:8787/rec  (or press the "rec" chip) to start.
const CAPTIONS = [
  ["01 ON CAMERA", "A solo creator is the whole crew — until now."],
  ["02 CREW", "One voice, five jobs: camera, focus, light, sound, script."],
  ["03 CAMERAMAN", "“Give me a close-up.”"],
  ["04 FOCUS", "“Pull focus to my hands.”"],
  ["05 LIGHTING", "“A bit darker. White balance warm.”"],
  ["06 SOUND", "“A bit louder. Kill the fan noise.”"],
  ["07 PROMPTER", "“Make me a run sheet for unboxing the new mic, 6 minutes.”"],
  ["08 ROLL", "“Roll a take on the intro scene. Next line. Slower please.”"],
  ["09 DIRECTOR", "“Cut, take it again.” — the take keeps rolling."],
  ["10 KEEP", "“That was gold, and it lands.” — saved for the editor."],
  ["11 LIVE", "“Go live on YouTube.”"],
  ["12 GUARD", "“Stop the stream.” — refused: a misheard word must never take you off air."],
  ["13 PACKAGE", "“Draft me a title and description.” — one download for the editor."],
  ["14 MCP", "18 typed tools · Streamable HTTP · sub-millisecond calls."],
];

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const caption = (step, text) => {
  const bar = $("caption-bar");
  $("cap-step").textContent = step;
  $("cap-text").textContent = text;
  bar.classList.remove("flash");
  void bar.offsetWidth;
  bar.classList.add("flash");
};

async function speak(utterance, hold = 900) {
  const input = $("input");
  input.focus();
  input.value = "";
  for (const ch of utterance) {
    input.value += ch;
    await sleep(28 + Math.random() * 34);
  }
  await sleep(320);
  input.form.requestSubmit();
  await sleep(hold);
}

async function play() {
  await fetch("/api/reset", { method: "POST" });
  caption(...CAPTIONS[0]);
  await sleep(1600);
  caption(...CAPTIONS[1]);
  await sleep(2200);

  caption(...CAPTIONS[2]);
  await speak("give me a close-up", 1100);
  caption(...CAPTIONS[3]);
  await speak("pull focus to my hands", 1100);
  await sleep(700);

  caption(...CAPTIONS[4]);
  await speak("a bit darker", 900);
  await speak("set white balance warm", 900);
  await sleep(500);

  caption(...CAPTIONS[5]);
  await speak("a bit louder", 900);
  await speak("kill the fan noise", 900);
  await sleep(600);

  caption(...CAPTIONS[6]);
  await speak("make me a run sheet for unboxing the new mic, 6 minutes", 1400);

  caption(...CAPTIONS[7]);
  await speak("roll a take on the intro scene", 1400);
  await sleep(1200);
  await speak("next line", 1000);
  await speak("slower please", 1000);
  await sleep(900);

  caption(...CAPTIONS[8]);
  await speak("cut, take it again", 1200);
  caption(...CAPTIONS[9]);
  await speak("that was gold, and it lands", 1200);
  await sleep(600);

  caption(...CAPTIONS[10]);
  await speak("go live on youtube", 1300);
  caption(...CAPTIONS[11]);
  await speak("stop the stream", 1800);
  await sleep(900);

  caption(...CAPTIONS[12]);
  await speak("draft me a title and description", 1500);
  await sleep(700);

  caption(...CAPTIONS[13]);
  await sleep(300);
  $("cap-text").textContent = "CreatorStudio · github.com/YeEandtree/creator-studio-alexa";
}

if (location.pathname.endsWith("/rec") || new URLSearchParams(location.search).has("rec")) {
  play();
}
