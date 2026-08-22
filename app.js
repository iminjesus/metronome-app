/**
 * Metronome — accurate timing via the Web Audio API.
 *
 * Uses a look-ahead scheduler (Chris Wilson's "A Tale of Two Clocks" pattern):
 * a setInterval fires frequently but only schedules audio events that fall
 * inside a short look-ahead window, so click timing rides on the sample-accurate
 * audio clock instead of the jittery JS timer.
 *
 * The metronome can be driven entirely by voice (speech recognition), including
 * a spoken "speed ramp" that raises the tempo automatically and announces each
 * change out loud.
 */

// --- Tempo naming (traditional Italian markings) ---
const TEMPO_NAMES = [
  [40, "Grave"],
  [60, "Largo"],
  [66, "Larghetto"],
  [76, "Adagio"],
  [108, "Andante"],
  [121, "Moderato"],
  [156, "Allegro"],
  [176, "Vivace"],
  [200, "Presto"],
  [Infinity, "Prestissimo"],
];

function tempoName(bpm) {
  for (const [max, name] of TEMPO_NAMES) {
    if (bpm < max) return name;
  }
  return "";
}

const BPM_MIN = 30;
const BPM_MAX = 240;
const clampBpm = (n) => Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(n)));
const clampRange = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));

// --- State ---
const state = {
  bpm: 120,
  beatsPerBar: 4,
  isPlaying: false,
  currentBeat: 0, // 0-indexed beat within the bar for the *next* scheduled note
  nextNoteTime: 0, // audio-clock time of the next note
};

const LOOKAHEAD_MS = 25; // how often the scheduler wakes up
const SCHEDULE_AHEAD = 0.1; // how far ahead (seconds) to schedule audio

let audioCtx = null;
let schedulerTimer = null;
// Queue of {beat, time} so the visual can be flipped exactly when a note plays.
const notesInQueue = [];

// --- DOM ---
const el = {
  bpmValue: document.getElementById("bpmValue"),
  tempoName: document.getElementById("tempoName"),
  slider: document.getElementById("bpmSlider"),
  beats: document.getElementById("beats"),
  beatsPerBar: document.getElementById("beatsPerBar"),
  startBtn: document.getElementById("startBtn"),
  tapBtn: document.getElementById("tapBtn"),
  rampStatus: document.getElementById("rampStatus"),
  // Voice Control (speech recognition)
  voicePanel: document.getElementById("voicePanel"),
  voiceToggle: document.getElementById("voiceToggle"),
  micBtn: document.getElementById("micBtn"),
  vcLang: document.getElementById("vcLang"),
  vcHeard: document.getElementById("vcHeard"),
  vcCmd: document.getElementById("vcCmd"),
};

// --- Audio ---
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

/** Schedule a short click at the given audio-clock time. Accent = first beat. */
function scheduleClick(beat, time) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const isAccent = beat === 0;

  osc.frequency.value = isAccent ? 1500 : 1000;

  // Fast percussive envelope so clicks don't smear.
  const peak = isAccent ? 0.6 : 0.4;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(time);
  osc.stop(time + 0.06);

  notesInQueue.push({ beat, time });
}

function advanceNote() {
  const secondsPerBeat = 60.0 / state.bpm;
  state.nextNoteTime += secondsPerBeat;
  state.currentBeat = (state.currentBeat + 1) % state.beatsPerBar;
}

function scheduler() {
  while (state.nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    scheduleClick(state.currentBeat, state.nextNoteTime);
    advanceNote();
  }
}

// --- Visual sync ---
function drawLoop() {
  if (!state.isPlaying) return;
  const now = audioCtx.currentTime;
  while (notesInQueue.length && notesInQueue[0].time <= now) {
    flashBeat(notesInQueue.shift().beat);
  }
  requestAnimationFrame(drawLoop);
}

function flashBeat(beat) {
  const dots = el.beats.children;
  for (let i = 0; i < dots.length; i++) {
    dots[i].classList.remove("active", "accent");
  }
  const dot = dots[beat];
  if (dot) {
    dot.classList.add("active");
    if (beat === 0) dot.classList.add("accent");
  }
}

// --- Transport ---
function start() {
  ensureAudio();
  state.isPlaying = true;
  state.currentBeat = 0;
  state.nextNoteTime = audioCtx.currentTime + 0.05;
  notesInQueue.length = 0;
  schedulerTimer = setInterval(scheduler, LOOKAHEAD_MS);
  requestAnimationFrame(drawLoop);
  el.startBtn.textContent = "Stop";
  el.startBtn.classList.add("playing");
}

function stop() {
  state.isPlaying = false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  notesInQueue.length = 0;
  for (const dot of el.beats.children) {
    dot.classList.remove("active", "accent");
  }
  el.startBtn.textContent = "Start";
  el.startBtn.classList.remove("playing");
  // Stopping the metronome also cancels a running ramp.
  if (trainer.active) stopTrainer();
}

function toggle() {
  state.isPlaying ? stop() : start();
}

// --- BPM handling ---
function setBpm(bpm) {
  state.bpm = clampBpm(bpm);
  el.bpmValue.textContent = state.bpm;
  el.tempoName.textContent = tempoName(state.bpm);
  el.slider.value = state.bpm;
  const pct = ((state.bpm - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100;
  el.slider.style.setProperty("--fill", pct + "%");
}

function buildBeatDots() {
  el.beats.innerHTML = "";
  for (let i = 0; i < state.beatsPerBar; i++) {
    const dot = document.createElement("div");
    dot.className = "beat-dot";
    el.beats.appendChild(dot);
  }
}

function setBeatsPerBar(n) {
  n = Math.max(1, Math.min(8, Math.round(n)));
  state.beatsPerBar = n;
  state.currentBeat = 0;
  el.beatsPerBar.value = String(n);
  buildBeatDots();
}

// --- Tap tempo ---
let tapTimes = [];
function tap() {
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) {
    tapTimes = [];
  }
  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes.shift();

  if (tapTimes.length >= 2) {
    let total = 0;
    for (let i = 1; i < tapTimes.length; i++) {
      total += tapTimes[i] - tapTimes[i - 1];
    }
    setBpm(60000 / (total / (tapTimes.length - 1)));
  }
}

/* =========================================================================
 * Voice announcements (Text-to-Speech). The spoken voice follows the chosen
 * recognition language, so commands and announcements share one language.
 * ========================================================================= */

let voices = [];

const PHRASES = {
  en: { start: "Start", done: "Target reached" },
  ko: { start: "시작", done: "목표 도달" },
  ja: { start: "スタート", done: "目標達成" },
  zh: { start: "开始", done: "达到目标" },
  es: { start: "Comenzar", done: "Objetivo alcanzado" },
  fr: { start: "Commencer", done: "Objectif atteint" },
  de: { start: "Start", done: "Ziel erreicht" },
  it: { start: "Via", done: "Obiettivo raggiunto" },
  pt: { start: "Começar", done: "Objetivo alcançado" },
  ru: { start: "Старт", done: "Цель достигнута" },
};

function loadVoices() {
  if ("speechSynthesis" in window) voices = window.speechSynthesis.getVoices();
}

/** Pick a TTS voice matching the currently selected recognition language. */
function selectedVoice() {
  if (!voices.length) return null;
  const want = (el.vcLang.value || navigator.language || "en").toLowerCase();
  const prefix = want.split("-")[0];
  return (
    voices.find((v) => v.lang.toLowerCase() === want) ||
    voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ||
    voices[0]
  );
}

function phraseFor(voice, key) {
  const lang = (voice ? voice.lang : el.vcLang.value || "en").toLowerCase();
  return (PHRASES[lang.split("-")[0]] || PHRASES.en)[key];
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = selectedVoice();
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  }
  u.rate = 1;
  u.volume = 1;
  window.speechSynthesis.speak(u);
}

function speakNumber(n) {
  speak(String(n));
}

/* =========================================================================
 * Speed ramp — started and configured by voice.
 * ========================================================================= */

const trainer = {
  active: false,
  target: 150,
  step: 10,
  interval: 30,
  dir: 1,
  stepTimer: null,
  countdown: null,
  remaining: 0,
};

/**
 * Does this phrase describe a speed ramp? True when it names the ramp
 * explicitly ("trainer"/"트레이너") or has both a start and a target — e.g.
 * "50 to 150", "50부터 시작해서 200까지", "from 50 up to 200".
 */
function isRampPhrase(text) {
  if (matchAny(text, KEYWORDS.trainer)) return true;
  // Two numbers joined by a range word ("50 to 150", "50에서 150").
  if (/(\d{1,3})\s*(?:to|~|–|-|에서|부터)\s*(\d{1,3})/.test(text)) return true;
  // Separate start and target markers, possibly with words between them.
  const hasStart =
    /(\d{1,3})\s*(?:부터|에서)/.test(text) || /\b(?:from|starting)\b/.test(text);
  const hasTarget =
    /(\d{1,3})\s*까지/.test(text) || /\b(?:to|until)\b/.test(text);
  if (hasStart && hasTarget) return true;
  if (/시작/.test(text) && /까지/.test(text)) return true;
  return false;
}

/**
 * Parse a spoken ramp command into { start, target, step, interval }.
 * Understands loose phrasing like "trainer 50 to 150 by 10 every 30",
 * "50부터 시작해서 200까지 10씩 30초마다", "from 50 up to 200 step 5 every 20
 * seconds". Any missing part uses a default. Start/target are found by their
 * markers (부터/에서/from, 까지/to/until) so words may sit between them.
 */
function parseTrainerConfig(text) {
  const cfg = { start: 50, target: 150, step: 10, interval: 30 };
  let m;

  // Interval (seconds between steps).
  if ((m = text.match(/(?:every|각|매|마다|간격)\s*(\d{1,3})/)))
    cfg.interval = clampRange(+m[1], 2, 600);
  if ((m = text.match(/(\d{1,3})\s*(?:초|secs?|seconds?)/)))
    cfg.interval = clampRange(+m[1], 2, 600);

  // Step size.
  if ((m = text.match(/(?:by|steps?(?:\s+of)?|스텝|단계)\s*(\d{1,3})/)))
    cfg.step = clampRange(+m[1], 1, 60);
  if ((m = text.match(/(\d{1,3})\s*씩/))) cfg.step = clampRange(+m[1], 1, 60);

  // Start & target via markers (allow words in between).
  let startN = null;
  let targetN = null;
  if ((m = text.match(/(\d{1,3})\s*(?:부터|에서)/))) startN = +m[1];
  else if ((m = text.match(/(?:from|starting(?:\s+at)?)\s+(\d{1,3})/)))
    startN = +m[1];

  if ((m = text.match(/(\d{1,3})\s*까지/))) targetN = +m[1];
  else if ((m = text.match(/(?:up to|\bto\b|\buntil\b|목표)\s*(\d{1,3})/)))
    targetN = +m[1];

  // Adjacent "A to B" fallback fills whichever marker was missing.
  if (startN === null || targetN === null) {
    m = text.match(/(\d{1,3})\s*(?:to|~|–|-|에서|부터)\s*(\d{1,3})/);
    if (m) {
      if (startN === null) startN = +m[1];
      if (targetN === null) targetN = +m[2];
    }
  }

  if (startN !== null) cfg.start = clampBpm(startN);
  if (targetN !== null) cfg.target = clampBpm(targetN);
  return cfg;
}

function startTrainer(cfg) {
  trainer.active = true;
  trainer.target = cfg.target;
  trainer.step = cfg.step;
  trainer.interval = cfg.interval;
  trainer.dir = cfg.target >= cfg.start ? 1 : -1;

  ensureAudio();
  setBpm(cfg.start);
  if (!state.isPlaying) start();

  speak(`${phraseFor(selectedVoice(), "start")}. ${cfg.start}`);

  if (state.bpm === trainer.target) finishTrainer();
  else scheduleNextStep();
}

function scheduleNextStep() {
  trainer.remaining = trainer.interval;
  renderRamp();
  trainer.countdown = setInterval(() => {
    trainer.remaining = Math.max(0, trainer.remaining - 1);
    renderRamp();
  }, 1000);
  trainer.stepTimer = setTimeout(stepTrainer, trainer.interval * 1000);
}

function stepTrainer() {
  clearInterval(trainer.countdown);

  let next = state.bpm + trainer.dir * trainer.step;
  next = trainer.dir > 0
    ? Math.min(next, trainer.target)
    : Math.max(next, trainer.target);

  setBpm(next);
  speakNumber(next);

  if (next === trainer.target) finishTrainer();
  else scheduleNextStep();
}

function finishTrainer() {
  clearTimers();
  trainer.active = false;
  el.rampStatus.hidden = false;
  el.rampStatus.classList.add("done");
  el.rampStatus.textContent = `✓ ${trainer.target} BPM reached`;
  speak(`${phraseFor(selectedVoice(), "done")}. ${trainer.target}`);
  // Keep playing at the target tempo; the user stops when ready.
}

function stopTrainer() {
  clearTimers();
  trainer.active = false;
  el.rampStatus.hidden = true;
  el.rampStatus.classList.remove("done");
}

function clearTimers() {
  clearTimeout(trainer.stepTimer);
  clearInterval(trainer.countdown);
  trainer.stepTimer = null;
  trainer.countdown = null;
}

function renderRamp() {
  el.rampStatus.hidden = false;
  el.rampStatus.classList.remove("done");
  const arrow = trainer.dir > 0 ? "↑" : "↓";
  el.rampStatus.textContent =
    `🎯 ${state.bpm} ${arrow} ${trainer.target} · +${trainer.step}` +
    ` · next in ${trainer.remaining}s`;
}

/* =========================================================================
 * Voice Control — Speech Recognition (Web Speech API)
 * ========================================================================= */

const RECOG_LANGS = [
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["ko-KR", "한국어"],
  ["ja-JP", "日本語"],
  ["zh-CN", "中文 (简体)"],
  ["zh-TW", "中文 (繁體)"],
  ["es-ES", "Español"],
  ["fr-FR", "Français"],
  ["de-DE", "Deutsch"],
  ["it-IT", "Italiano"],
  ["pt-BR", "Português (BR)"],
  ["ru-RU", "Русский"],
  ["hi-IN", "हिन्दी"],
];

const KEYWORDS = {
  play: ["start", "play", "go", "begin", "resume", "run", "시작", "고", "재생",
    "플레이", "スタート", "始め", "再生", "开始", "播放", "empezar", "iniciar",
    "comenzar", "commencer", "jouer", "spielen", "avvia", "tocar", "старт",
    "начать"],
  stop: ["stop", "pause", "halt", "end", "quit", "정지", "멈춰", "그만", "스톱",
    "꺼", "停止", "止め", "停", "暂停", "parar", "detener", "alto", "arrêter",
    "stopp", "ferma", "стоп", "стой"],
  faster: ["faster", "speed up", "quicker", "빠르게", "빨리", "더 빨리",
    "速く", "はやく", "快", "快点", "更快", "más rápido", "rapido", "rápido",
    "plus vite", "schneller", "più veloce", "быстрее"],
  slower: ["slower", "slow down", "느리게", "천천히", "더 느리게", "遅く",
    "おそく", "慢", "慢点", "更慢", "más lento", "lento", "plus lent",
    "langsamer", "più lento", "медленнее"],
  tap: ["tap", "탭", "タップ", "点击", "toque", "taper"],
  trainer: ["trainer", "train", "ramp", "훈련", "연습", "트레이너", "램프",
    "トレーナー", "練習", "训练", "练习", "entrenador", "entraîneur",
    "trainingsmodus"],
  reset: ["reset", "리셋", "초기화", "リセット", "重置", "reiniciar",
    "réinitialiser", "zurücksetzen"],
};

const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};

/** Extract a beats-per-bar value from "3/4", "waltz", "3박자", etc. */
function parseBeats(text) {
  if (/waltz|왈츠|walzer|valse/.test(text)) return 3;

  const frac = text.match(/([1-8])\s*[/\s]\s*[1-9]\b/);
  if (frac) return parseInt(frac[1], 10);

  const wordNums = [];
  const re = /\b(one|two|three|four|five|six|seven|eight)\b/g;
  let m;
  while ((m = re.exec(text))) wordNums.push(WORD_NUM[m[1]]);
  if (wordNums.length >= 2) return wordNums[0];

  const beatKw =
    /beat|signature|\btime\b|박자|拍子|拍|takt|tiempo|temps|comp[áa]s/.test(
      text
    );
  if (beatKw) {
    const dm = text.match(/([1-8])/);
    if (dm) return parseInt(dm[1], 10);
    if (wordNums.length) return wordNums[0];
  }
  return 0;
}

let recognition = null;
let listening = false;

function matchAny(text, list) {
  return list.some((kw) => text.includes(kw));
}

function flashCmd(label) {
  el.vcCmd.textContent = label;
  el.vcCmd.classList.remove("flash");
  void el.vcCmd.offsetWidth; // restart the animation
  el.vcCmd.classList.add("flash");
}

/** Interpret a recognized phrase and act on it. */
function handleTranscript(raw) {
  const text = raw.toLowerCase().trim();
  el.vcHeard.textContent = "“" + raw.trim() + "”";

  // Reset tempo + time signature.
  if (matchAny(text, KEYWORDS.reset)) {
    stopTrainer();
    setBpm(120);
    setBeatsPerBar(4);
    flashCmd("Reset · 120 · 4 beats");
    return;
  }

  // Speed ramp — checked before number/beat parsing so its numbers aren't
  // mistaken for a tempo or time signature.
  if (isRampPhrase(text)) {
    const hasNums = /\d{2,3}/.test(text);
    // A bare "trainer"/"ramp" with no numbers toggles a running ramp off.
    if (!hasNums && trainer.active) {
      stopTrainer();
      flashCmd("Ramp ■");
      return;
    }
    const cfg = parseTrainerConfig(text);
    if (trainer.active) stopTrainer(); // restart with the new settings
    startTrainer(cfg);
    flashCmd(`Ramp ▶ ${cfg.start}→${cfg.target}`);
    return;
  }

  // Time signature — "3/4", "6/8", "waltz", "3박자", "beats 3".
  const beats = parseBeats(text);
  if (beats) {
    setBeatsPerBar(beats);
    flashCmd("Time · " + beats + " beats/bar");
    return;
  }

  // A spoken number (2–3 digits) sets the tempo directly.
  const num = text.match(/\d{2,3}/);
  if (num) {
    const n = parseInt(num[0], 10);
    if (n >= BPM_MIN && n <= BPM_MAX) {
      stopTrainer();
      setBpm(n);
      if (!state.isPlaying) start();
      flashCmd("→ " + n + " BPM");
      return;
    }
  }

  if (matchAny(text, KEYWORDS.faster)) {
    stopTrainer();
    setBpm(state.bpm + 5);
    flashCmd("Faster · " + state.bpm);
    return;
  }
  if (matchAny(text, KEYWORDS.slower)) {
    stopTrainer();
    setBpm(state.bpm - 5);
    flashCmd("Slower · " + state.bpm);
    return;
  }
  if (matchAny(text, KEYWORDS.tap)) {
    tap();
    flashCmd("Tap");
    return;
  }
  if (matchAny(text, KEYWORDS.stop)) {
    if (state.isPlaying) stop();
    flashCmd("Stop");
    return;
  }
  if (matchAny(text, KEYWORDS.play)) {
    if (!state.isPlaying) start();
    flashCmd("Play");
    return;
  }

  flashCmd("—"); // heard something, but no command matched
}

function populateRecogLangs() {
  RECOG_LANGS.forEach(([code, label]) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label;
    el.vcLang.appendChild(opt);
  });
  const bl = (navigator.language || "en-US").toLowerCase();
  const exact = RECOG_LANGS.find(([c]) => c.toLowerCase() === bl);
  const loose = RECOG_LANGS.find(([c]) =>
    c.toLowerCase().startsWith(bl.split("-")[0])
  );
  if (exact) el.vcLang.value = exact[0];
  else if (loose) el.vcLang.value = loose[0];
}

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    el.micBtn.disabled = true;
    el.micBtn.textContent = "🎤 Not supported";
    el.vcHeard.innerHTML =
      '<span class="vc-unsupported">Speech recognition needs Chrome or Edge.</span>';
    el.vcLang.disabled = true;
    return;
  }

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    if (result.isFinal) handleTranscript(result[0].transcript);
  };

  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      listening = false;
      setMicUI(false);
      el.vcHeard.innerHTML =
        '<span class="vc-unsupported">Microphone permission denied.</span>';
    }
  };

  recognition.onend = () => {
    if (listening) {
      try {
        recognition.start();
      } catch (_) {
        /* already starting */
      }
    }
  };
}

function setMicUI(on) {
  el.micBtn.classList.toggle("listening", on);
  el.micBtn.textContent = on ? "🛑 Stop Listening" : "🎤 Start Listening";
  if (on) {
    el.vcHeard.textContent = "Listening… say a command";
  } else if (!el.vcHeard.querySelector(".vc-unsupported")) {
    el.vcHeard.textContent = "Mic off";
  }
}

function startListening() {
  if (!recognition) return;
  ensureAudio();
  recognition.lang = el.vcLang.value;
  listening = true;
  try {
    recognition.start();
  } catch (_) {
    /* already running */
  }
  setMicUI(true);
}

function stopListening() {
  listening = false;
  if (recognition) recognition.stop();
  setMicUI(false);
}

function toggleListening() {
  listening ? stopListening() : startListening();
}

/* =========================================================================
 * Events
 * ========================================================================= */

el.slider.addEventListener("input", (e) => {
  if (trainer.active) stopTrainer(); // manual override cancels the ramp
  setBpm(Number(e.target.value));
});

document.querySelectorAll(".nudge-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (trainer.active) stopTrainer();
    setBpm(state.bpm + Number(btn.dataset.delta));
  });
});

el.beatsPerBar.addEventListener("change", (e) => {
  setBeatsPerBar(Number(e.target.value));
});

el.startBtn.addEventListener("click", toggle);
el.tapBtn.addEventListener("click", tap);

el.micBtn.addEventListener("click", toggleListening);
el.vcLang.addEventListener("change", () => {
  if (listening && recognition) recognition.stop(); // onend restarts with new lang
});

el.voiceToggle.addEventListener("click", () => {
  const collapsed = el.voicePanel.classList.toggle("collapsed");
  el.voiceToggle.setAttribute("aria-expanded", String(!collapsed));
});

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  if (e.code === "Space") {
    e.preventDefault();
    toggle();
  } else if (e.key.toLowerCase() === "t") {
    e.preventDefault();
    tap();
  }
});

// --- Init ---
buildBeatDots();
setBpm(120);
loadVoices();
if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
}
populateRecogLangs();
initRecognition();

// Always-on: begin listening as soon as the page loads so the app can be
// controlled entirely by voice. The browser asks for mic permission once.
startListening();

// Audio playback needs one user gesture to unlock. Any tap or key press does it.
function unlockAudioOnce() {
  ensureAudio();
  window.removeEventListener("pointerdown", unlockAudioOnce);
  window.removeEventListener("keydown", unlockAudioOnce);
}
window.addEventListener("pointerdown", unlockAudioOnce);
window.addEventListener("keydown", unlockAudioOnce);

// Register the service worker so the app is installable and works offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
