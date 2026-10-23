// CreatorStudio simulator — talks to the creator-studio MCP server over HTTP.
// Voice: Web Speech API when the browser has it (Chrome/Edge), text always.

const $ = (id) => document.getElementById(id);
const els = {
  recDot: $("rec-dot"), recLabel: $("rec-label"),
  stage: $("scene-stage"), stageScene: $("stage-scene"), stageTake: $("stage-take"), stageClock: $("stage-clock"),
  live: $("live-badge"),
  light: $("meter-light"), outLight: $("out-light"),
  mic: $("meter-mic"), outMic: $("out-mic"),
  swatches: $("swatches"), scenes: document.querySelector(".scenes"),
  cues: $("cue-list"), cueCount: $("cue-count"),
  orb: $("orb"), micBtn: $("mic-btn"), hint: $("hint"),
  card: $("alexa-card"), cardTool: $("card-tool"), cardSpeech: $("card-speech"), cardBody: $("card-body"),
  form: $("composer"), input: $("input"), chips: $("chips"),
  journal: $("journal"),
  modePill: $("mode-pill"), latencyPill: $("latency-pill"), reset: $("reset-btn"),
};

let clockTimer = null;
let lastState = null;

const clock = (s) => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

function renderState(state, journal) {
  lastState = state;
  const r = state.recording;
  els.recDot.dataset.status = r.status;
  els.recLabel.textContent = r.status;
  els.stageClock.textContent = clock(r.elapsedSec);
  els.stageTake.textContent = `take ${r.take}`;
  els.stageScene.textContent = state.scene.toUpperCase();
  els.stage.dataset.scene = state.scene;
  els.stage.dataset.temp = state.lighting.temperature;

  els.light.style.width = `${state.lighting.key}%`;
  els.outLight.textContent = `${state.lighting.key}%`;
  els.mic.style.width = state.audio.muted ? "0%" : "100%";
  els.outMic.textContent = state.audio.muted ? "muted" : "live";

  for (const b of els.swatches.querySelectorAll("button")) {
    b.classList.toggle("is-on", b.dataset.temp === state.lighting.temperature);
  }
  for (const b of els.scenes.querySelectorAll("button")) {
    b.classList.toggle("is-on", b.dataset.scene === state.scene);
  }
  els.live.hidden = !state.restream.live;

  els.cueCount.textContent = String(state.cues.length);
  els.cues.innerHTML = state.cues.length
    ? state.cues.map((c) => `<li><span>${escapeHtml(c.label)}</span><b>${clock(c.atSec)}</b></li>`).join("")
    : `<li class="empty">Say “mark the hook” during a take.</li>`;

  if (journal) renderJournal(journal);
}

function renderJournal(journal) {
  const recent = journal.slice(-14).reverse();
  els.journal.innerHTML = recent.length
    ? recent
        .map(
          (e) => `
      <li class="call ${e.ok ? "" : "bad"}">
        <div class="top"><span class="tool">${escapeHtml(e.tool)}</span><span class="lat">${Math.round(e.latencyMs * 100) / 100} ms · ${e.mode}</span></div>
        <div class="sum">${escapeHtml(e.summary)}</div>
        ${e.detail && Object.keys(e.detail).length ? `<div class="args">${escapeHtml(JSON.stringify(e.detail))}</div>` : ""}
      </li>`,
        )
        .join("")
    : `<li class="empty">Tool calls appear here with latency and mode.</li>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderCard(routed, result) {
  els.cardTool.textContent = `${routed.tool}(${Object.keys(routed.args).length ? JSON.stringify(routed.args) : ""})`;
  els.cardSpeech.textContent = result.speech;
  els.cardSpeech.classList.toggle("denied", !result.ok);
  els.card.classList.remove("flash");
  void els.card.offsetWidth;
  els.card.classList.add("flash");

  const card = result.data?.card;
  let html = "";
  if (card?.type === "status") {
    html = card.rows.map((r) => `<div class="row"><span>${escapeHtml(r.label)}</span><b>${escapeHtml(r.value)}</b></div>`).join("");
  } else if (card?.type === "checklist") {
    html = card.items.map((i) => `<div class="check ${i.ok ? "" : "bad"}"><span class="dot"></span>${escapeHtml(i.label)}</div>`).join("");
  } else if (card?.type === "script") {
    html = `<div class="sheet">${card.sections
      .map((s) => `<div class="sec"><span>${clock(s.atSec)}</span>${escapeHtml(s.heading)}</div>`)
      .join("")}</div>`;
  } else if (result.data?.issues?.length) {
    html = result.data.issues
      .map((i) => `<div class="check ${i.level === "ok" ? "" : "bad"}"><span class="dot"></span>${escapeHtml(i.message)}</div>`)
      .join("");
  }
  els.cardBody.innerHTML = html;
}

/* ------------------------------ networking ------------------------------ */
async function refresh() {
  const res = await fetch("/api/state");
  const data = await res.json();
  els.modePill.textContent = `mode: ${data.mode}`;
  renderState(data.state, data.journal);
}

let clockTick = null;
function startClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    if (!lastState || lastState.recording.status !== "recording") return;
    lastState.recording.elapsedSec += 1;
    els.stageClock.textContent = clock(lastState.recording.elapsedSec);
  }, 1000);
}

async function send(utterance) {
  const text = String(utterance || "").trim();
  if (!text) return;
  els.orb.dataset.state = "thinking";
  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance: text }),
    });
    const data = await res.json();
    renderCard(data.routed, data.result);
    renderState(data.state);
    const lat = `${data.result.data?.latencyMs ?? "—"} ms tool · ${data.totalMs} ms round-trip`;
    els.latencyPill.textContent = lat;
    await refresh();
    speak(data.result.speech);
  } catch (err) {
    els.cardSpeech.textContent = `Network error: ${err.message}`;
  } finally {
    els.orb.dataset.state = "idle";
  }
}

/* --------------------------------- voice -------------------------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let holding = false;

if (SR) {
  recognition = new SR();
  recognition.interimResults = true;
  recognition.lang = navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map((r) => r[0].transcript).join(" ");
    els.input.value = transcript;
    els.hint.textContent = transcript;
  };
  recognition.onend = () => {
    els.orb.dataset.state = "idle";
    const spoken = els.input.value.trim();
    if (spoken) {
      els.input.value = "";
      send(spoken);
    }
  };
  recognition.onerror = (e) => {
    els.orb.dataset.state = "idle";
    els.hint.textContent = `Speech error: ${e.error} — you can type instead.`;
  };
} else {
  els.hint.textContent = "This browser has no speech recognition — type a command instead.";
}

function startListening() {
  if (!recognition || holding) return;
  holding = true;
  els.orb.dataset.state = "listening";
  els.hint.textContent = "Listening…";
  try { recognition.start(); } catch { /* already started */ }
}
function stopListening() {
  holding = false;
  try { recognition?.stop(); } catch { /* noop */ }
}

els.micBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startListening(); });
els.micBtn.addEventListener("pointerup", stopListening);
els.micBtn.addEventListener("pointerleave", stopListening);
// Click fallback (tap = one utterance).
els.micBtn.addEventListener("click", () => {
  if (!holding) { startListening(); setTimeout(stopListening, 3200); }
});

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.04;
  u.pitch = 1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/* ------------------------------- wiring -------------------------------- */
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = els.input.value;
  els.input.value = "";
  send(v);
});

els.chips.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) send(b.textContent);
});

els.scenes.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) send(`switch to the ${b.dataset.scene} scene`);
});

els.swatches.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) send(`set white balance ${b.dataset.temp}`);
});

els.reset.addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  els.cardTool.textContent = "studio.get_status()";
  els.cardSpeech.textContent = "Studio reset. Ready when you are.";
  els.cardBody.innerHTML = "";
  refresh();
});

refresh().then(startClock);
setInterval(refresh, 5000);

/* ------------------------- demo reel (?demo=1) ------------------------- */
// Used for the 3-minute submission video: plays a short, deterministic script of
// real tool calls so the recording never depends on speech recognition.
const DEMO_SCRIPT = [
  "you are idle, roll when ready",
  "roll a take on the intro scene",
  "mark that, the best take of the hook",
  "a bit darker",
  "switch to b-roll",
  "set white balance warm",
  "go live on youtube",
  "stop the stream",
  "that’s a wrap",
];

async function runDemo() {
  await fetch("/api/reset", { method: "POST" });
  await refresh();
  for (const line of DEMO_SCRIPT) {
    els.orb.dataset.state = "listening";
    els.input.value = line;
    els.hint.textContent = `“${line}”`;
    await new Promise((r) => setTimeout(r, 900));
    els.orb.dataset.state = "thinking";
    await new Promise((r) => setTimeout(r, 250));
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance: line }),
    });
    const data = await res.json();
    renderCard(data.routed, data.result);
    renderState(data.state);
    els.latencyPill.textContent = `${data.result.data?.latencyMs ?? "—"} ms tool · ${data.totalMs} ms round-trip`;
    await refresh();
    els.input.value = "";
    els.orb.dataset.state = "idle";
    await new Promise((r) => setTimeout(r, 700));
  }
  els.hint.textContent = "Demo finished — type or speak to drive the studio yourself.";
}

if (new URLSearchParams(location.search).has("demo")) {
  runDemo();
}
