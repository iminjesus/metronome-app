/**
 * Metronome — accurate timing via the Web Audio API.
 *
 * Uses a look-ahead scheduler (Chris Wilson's "A Tale of Two Clocks" pattern):
 * a setInterval fires frequently but only schedules audio events that fall
 * inside a short look-ahead window, so click timing rides on the sample-accurate
 * audio clock instead of the jittery JS timer.
 *
 * Also includes a Speed Trainer that ramps the tempo automatically and
 * announces each change out loud using the browser's speech synthesis
 * (any installed voice / language can be selected).
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
  // Trainer
  trainerPanel: document.getElementById("trainerPanel"),
  trainerToggle: document.getElementById("trainerToggle"),
  trainerBtn: document.getElementById("trainerBtn"),
  trainerStatus: document.getElementById("trainerStatus"),
  tStart: document.getElementById("tStart"),
  tTarget: document.getElementById("tTarget"),
  tStep: document.getElementById("tStep"),
  tInterval: document.getElementById("tInterval"),
  voiceOn: document.getElementById("voiceOn"),
  voiceSelect: document.getElementById("voiceSelect"),
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
  // Reveal any notes whose time has arrived.
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
  // Stopping the metronome also cancels a running trainer.
  if (trainer.active) stopTrainer(false);
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

// --- Tap tempo ---
let tapTimes = [];
function tap() {
  const now = performance.now();
  // Reset if the gap is too long (a new tapping session).
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
    const avgMs = total / (tapTimes.length - 1);
    setBpm(60000 / avgMs);
  }
}

/* =========================================================================
 * Voice announcements (Web Speech API — SpeechSynthesis)
 * ========================================================================= */

let voices = [];

// Short localized phrases keyed by language prefix; English is the fallback.
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

function selectedVoice() {
  const uri = el.voiceSelect.value;
  return voices.find((v) => v.voiceURI === uri) || null;
}

function phraseFor(voice, key) {
  const lang = (voice ? voice.lang : navigator.language || "en").toLowerCase();
  const prefix = lang.split("-")[0];
  return (PHRASES[prefix] || PHRASES.en)[key];
}

/** Speak arbitrary text with the currently selected voice. */
function speak(text) {
  if (!el.voiceOn.checked || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // don't let announcements pile up
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

/** Announce a BPM number — the chosen voice reads it in its own language. */
function speakNumber(n) {
  speak(String(n));
}

function populateVoices() {
  if (!("speechSynthesis" in window)) {
    el.voiceOn.checked = false;
    el.voiceOn.disabled = true;
    el.voiceSelect.disabled = true;
    return;
  }
  voices = window.speechSynthesis.getVoices();
  if (!voices.length) return; // will be called again on `voiceschanged`

  const prev = el.voiceSelect.value;
  el.voiceSelect.innerHTML = "";
  // Sort by language so related voices group together.
  voices
    .slice()
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name))
    .forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.lang} — ${v.name}`;
      el.voiceSelect.appendChild(opt);
    });

  // Restore previous choice, else prefer a voice matching the browser language.
  if (prev && voices.some((v) => v.voiceURI === prev)) {
    el.voiceSelect.value = prev;
  } else {
    const browserLang = (navigator.language || "en").toLowerCase();
    const match =
      voices.find((v) => v.lang.toLowerCase() === browserLang) ||
      voices.find((v) =>
        v.lang.toLowerCase().startsWith(browserLang.split("-")[0])
      );
    if (match) el.voiceSelect.value = match.voiceURI;
  }
}

/* =========================================================================
 * Speed Trainer — ramp the tempo automatically
 * ========================================================================= */

const trainer = {
  active: false,
  target: 150,
  step: 10,
  interval: 30, // seconds between steps
  stepTimer: null, // setTimeout to the next step
  countdown: null, // setInterval ticking the status each second
  remaining: 0, // seconds until the next step
};

function readTrainerConfig() {
  const startBpm = clampBpm(Number(el.tStart.value) || 50);
  const target = clampBpm(Number(el.tTarget.value) || 150);
  const step = Math.max(1, Math.round(Number(el.tStep.value) || 10));
  const interval = Math.max(2, Math.round(Number(el.tInterval.value) || 30));
  return { startBpm, target, step, interval };
}

function startTrainer() {
  const cfg = readTrainerConfig();
  trainer.active = true;
  trainer.target = cfg.target;
  trainer.step = cfg.step;
  trainer.interval = cfg.interval;

  // Direction-aware: works whether target is above or below the start.
  trainer.dir = cfg.target >= cfg.startBpm ? 1 : -1;

  ensureAudio(); // unlock audio + speech within the user gesture
  setBpm(cfg.startBpm);
  if (!state.isPlaying) start();

  el.trainerBtn.textContent = "Stop Trainer";
  el.trainerBtn.classList.add("running");

  speak(`${phraseFor(selectedVoice(), "start")}. ${cfg.startBpm}`);

  if (state.bpm === trainer.target) {
    finishTrainer();
  } else {
    scheduleNextStep();
  }
}

function scheduleNextStep() {
  trainer.remaining = trainer.interval;
  updateTrainerStatus();
  trainer.countdown = setInterval(() => {
    trainer.remaining = Math.max(0, trainer.remaining - 1);
    updateTrainerStatus();
  }, 1000);
  trainer.stepTimer = setTimeout(stepTrainer, trainer.interval * 1000);
}

function stepTrainer() {
  clearInterval(trainer.countdown);

  let next = state.bpm + trainer.dir * trainer.step;
  // Clamp to the target so we never overshoot.
  if (trainer.dir > 0) next = Math.min(next, trainer.target);
  else next = Math.max(next, trainer.target);

  setBpm(next);
  speakNumber(next);

  if (next === trainer.target) {
    finishTrainer();
  } else {
    scheduleNextStep();
  }
}

function finishTrainer() {
  clearTimers();
  trainer.active = false;
  el.trainerBtn.textContent = "Start Trainer";
  el.trainerBtn.classList.remove("running");
  el.trainerStatus.classList.add("active");
  el.trainerStatus.textContent = `✓ ${phraseFor(
    selectedVoice(),
    "done"
  )} · ${trainer.target} BPM`;
  speak(`${phraseFor(selectedVoice(), "done")}. ${trainer.target}`);
  // Keep playing at the target tempo; the user stops when ready.
}

/** Cancel a running trainer. `resetStatus` controls the status message. */
function stopTrainer(resetStatus = true) {
  clearTimers();
  trainer.active = false;
  el.trainerBtn.textContent = "Start Trainer";
  el.trainerBtn.classList.remove("running");
  el.trainerStatus.classList.remove("active");
  if (resetStatus) updateReadyStatus();
}

function clearTimers() {
  clearTimeout(trainer.stepTimer);
  clearInterval(trainer.countdown);
  trainer.stepTimer = null;
  trainer.countdown = null;
}

function updateTrainerStatus() {
  el.trainerStatus.classList.add("active");
  el.trainerStatus.textContent = `${state.bpm} → ${trainer.target} BPM · next in ${trainer.remaining}s`;
}

function updateReadyStatus() {
  const cfg = readTrainerConfig();
  el.trainerStatus.textContent = `Ready · ${cfg.startBpm} → ${cfg.target} BPM`;
}

function toggleTrainer() {
  trainer.active ? stopTrainer(true) : startTrainer();
}

/* =========================================================================
 * Events
 * ========================================================================= */

el.slider.addEventListener("input", (e) => {
  if (trainer.active) stopTrainer(true); // manual override cancels the ramp
  setBpm(Number(e.target.value));
});

document.querySelectorAll(".nudge-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (trainer.active) stopTrainer(true);
    setBpm(state.bpm + Number(btn.dataset.delta));
  });
});

function setBeatsPerBar(n) {
  n = Math.max(1, Math.min(8, Math.round(n)));
  state.beatsPerBar = n;
  state.currentBeat = 0;
  el.beatsPerBar.value = String(n);
  buildBeatDots();
}

el.beatsPerBar.addEventListener("change", (e) => {
  setBeatsPerBar(Number(e.target.value));
});

el.startBtn.addEventListener("click", toggle);
el.tapBtn.addEventListener("click", tap);

el.trainerBtn.addEventListener("click", toggleTrainer);

// Keep the "Ready" line in sync while editing config (when idle).
[el.tStart, el.tTarget, el.tStep, el.tInterval].forEach((input) => {
  input.addEventListener("input", () => {
    if (!trainer.active) updateReadyStatus();
  });
});

// Collapse / expand the trainer panel.
el.trainerToggle.addEventListener("click", () => {
  const collapsed = el.trainerPanel.classList.toggle("collapsed");
  el.trainerToggle.setAttribute("aria-expanded", String(!collapsed));
});

document.addEventListener("keydown", (e) => {
  // Ignore shortcuts while typing in the trainer inputs.
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

/* =========================================================================
 * Voice Control — Speech Recognition (Web Speech API)
 *
 * Lets the user drive the metronome by speaking. This works ALONGSIDE the
 * manual controls — sliders, buttons and voice commands all update the same
 * state, so you can use whichever you like at any moment.
 * ========================================================================= */

// Languages offered for recognition. SpeechRecognition can't enumerate these,
// so we list common locales; the browser needs matching language support.
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

// Command keywords across many languages — matched as substrings so the user
// doesn't have to phrase things exactly.
const KEYWORDS = {
  play: ["start", "play", "go", "begin", "시작", "재생", "플레이", "スタート",
    "始め", "再生", "开始", "播放", "empezar", "iniciar", "comenzar",
    "commencer", "jouer", "start", "spielen", "avvia", "tocar", "старт",
    "начать"],
  stop: ["stop", "pause", "halt", "정지", "멈춰", "그만", "스톱", "停止",
    "止め", "停", "暂停", "parar", "detener", "alto", "arrêter", "stopp",
    "ferma", "стоп", "стой"],
  faster: ["faster", "speed up", "quicker", "빠르게", "빨리", "더 빨리",
    "速く", "はやく", "快", "快点", "更快", "más rápido", "rapido", "rápido",
    "plus vite", "schneller", "più veloce", "быстрее"],
  slower: ["slower", "slow down", "느리게", "천천히", "더 느리게", "遅く",
    "おそく", "慢", "慢点", "更慢", "más lento", "lento", "plus lent",
    "langsamer", "più lento", "медленнее"],
  tap: ["tap", "탭", "タップ", "点击", "toque", "taper"],
  trainer: ["trainer", "train", "훈련", "연습", "트레이너", "トレーナー",
    "練習", "训练", "练习", "entrenador", "entraîneur", "trainingsmodus"],
  reset: ["reset", "리셋", "초기화", "リセット", "重置", "reiniciar",
    "réinitialiser", "zurücksetzen"],
};

// Number words used when spoken as a time signature ("three four").
const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};

/**
 * Extract a beats-per-bar value from a phrase like "3/4", "6/8", "waltz",
 * "3박자", or "three four time". Returns 0 if none is found.
 */
function parseBeats(text) {
  if (/waltz|왈츠|walzer|valse/.test(text)) return 3;

  // Fraction as digits: "3/4", "6/8", or spaced "6 8".
  const frac = text.match(/([1-8])\s*[/\s]\s*[1-9]\b/);
  if (frac) return parseInt(frac[1], 10);

  // Two number-words in a row, e.g. "three four", "four four", "six eight".
  const wordNums = [];
  const re = /\b(one|two|three|four|five|six|seven|eight)\b/g;
  let m;
  while ((m = re.exec(text))) wordNums.push(WORD_NUM[m[1]]);
  if (wordNums.length >= 2) return wordNums[0];

  // A single number next to a "time signature" keyword.
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

  // Reset tempo + time signature to defaults.
  if (matchAny(text, KEYWORDS.reset)) {
    if (trainer.active) stopTrainer(true);
    setBpm(120);
    setBeatsPerBar(4);
    flashCmd("Reset · 120 · 4 beats");
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
      if (trainer.active) stopTrainer(true);
      setBpm(n);
      if (!state.isPlaying) start();
      flashCmd("→ " + n + " BPM");
      return;
    }
  }

  // "trainer" is checked before play/stop so "start trainer" hits the trainer.
  if (matchAny(text, KEYWORDS.trainer)) {
    toggleTrainer();
    flashCmd(trainer.active ? "Trainer ▶" : "Trainer ■");
    return;
  }
  if (matchAny(text, KEYWORDS.faster)) {
    if (trainer.active) stopTrainer(true);
    setBpm(state.bpm + 5);
    flashCmd("Faster · " + state.bpm);
    return;
  }
  if (matchAny(text, KEYWORDS.slower)) {
    if (trainer.active) stopTrainer(true);
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
  // Default to the browser language if it's in the list.
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
    // "no-speech" / "aborted" are transient — onend will restart if listening.
  };

  // The engine stops on its own after silence; restart while we want to listen.
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
  ensureAudio(); // unlock audio inside the user gesture
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

el.micBtn.addEventListener("click", toggleListening);
el.vcLang.addEventListener("change", () => {
  // Apply the new language immediately by restarting recognition.
  if (listening && recognition) {
    recognition.stop(); // onend restarts with the updated lang
  }
});

el.voiceToggle.addEventListener("click", () => {
  const collapsed = el.voicePanel.classList.toggle("collapsed");
  el.voiceToggle.setAttribute("aria-expanded", String(!collapsed));
});

// --- Init ---
buildBeatDots();
setBpm(120);
updateReadyStatus();
populateVoices();
if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = populateVoices;
}
populateRecogLangs();
initRecognition();

// Always-on: begin listening as soon as the page loads so the app can be
// controlled entirely by voice. The browser asks for microphone permission
// the first time; after that it starts silently.
startListening();

// Audio playback needs one user gesture to unlock. If the player taps or
// presses any key even once, sound is enabled; otherwise the first spoken
// command also attempts to resume audio.
function unlockAudioOnce() {
  ensureAudio();
  window.removeEventListener("pointerdown", unlockAudioOnce);
  window.removeEventListener("keydown", unlockAudioOnce);
}
window.addEventListener("pointerdown", unlockAudioOnce);
window.addEventListener("keydown", unlockAudioOnce);
