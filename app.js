/**
 * Metronome — accurate timing via the Web Audio API.
 *
 * Look-ahead scheduler (Chris Wilson's "A Tale of Two Clocks"): a setInterval
 * fires often but only schedules audio that falls inside a short window, so
 * click timing rides the sample-accurate audio clock, not the JS timer.
 *
 * Tempo is set with an iPod-style click wheel (drag around it), the ± buttons,
 * tap tempo, or hands-free voice control (including a spoken speed ramp).
 */

// --- Tempo naming (traditional Italian markings) ---
const TEMPO_NAMES = [
  [40, "Grave"], [60, "Largo"], [66, "Larghetto"], [76, "Adagio"],
  [108, "Andante"], [121, "Moderato"], [156, "Allegro"], [176, "Vivace"],
  [200, "Presto"], [Infinity, "Prestissimo"],
];
function tempoName(bpm) {
  for (const [max, name] of TEMPO_NAMES) if (bpm < max) return name;
  return "";
}

// Spoken tempo markings → a representative BPM inside that marking's range.
const TEMPO_TERMS = [
  { bpm: 38, names: ["grave", "그라베"] },
  { bpm: 210, names: ["prestissimo", "프레스티시모", "프레스티시오"] },
  { bpm: 188, names: ["presto", "프레스토"] },
  { bpm: 166, names: ["vivace", "비바체"] },
  { bpm: 138, names: ["allegretto", "알레그레토", "알레그레또"] },
  { bpm: 138, names: ["allegro", "알레그로"] },
  { bpm: 114, names: ["moderato", "모데라토"] },
  { bpm: 92, names: ["andante", "안단테", "안단떼"] },
  { bpm: 70, names: ["adagio", "아다지오", "아다지어"] },
  { bpm: 63, names: ["larghetto", "라르게토", "라르게또"] },
  { bpm: 50, names: ["largo", "라르고"] },
];
function parseTempoTerm(text) {
  for (const t of TEMPO_TERMS) if (t.names.some((n) => text.includes(n))) return t.bpm;
  return 0;
}

/* Fuzzy matching for the fixed tempo-term vocabulary, so mis-transcriptions
 * still resolve — "moderato" heard as "모델아트", "프레스또", "moderat", etc.
 * Words are romanized (hangul → latin phonetics) and compared by edit distance. */
const HANGUL_CHO = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const HANGUL_JUNG = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const HANGUL_JONG = ["","g","kk","gs","n","nj","nh","d","l","lg","lm","lb","ls","lt","lp","lh","m","b","bs","s","ss","ng","j","ch","k","t","p","h"];

function romanize(s) {
  let out = "";
  for (const ch of s.toLowerCase()) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const x = code - 0xac00;
      out += HANGUL_CHO[Math.floor(x / 588)] +
        HANGUL_JUNG[Math.floor((x % 588) / 28)] +
        HANGUL_JONG[x % 28];
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    }
  }
  return out;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n];
}

const TEMPO_KEYS = TEMPO_TERMS.map((t) => ({
  bpm: t.bpm,
  keys: [...new Set(t.names.map(romanize).filter((k) => k.length >= 3))],
}));

/** Best tempo BPM for a single spoken word, or null if nothing is close. */
function matchTempoToken(token) {
  const r = romanize(token);
  if (r.length < 3) return null;
  let bestBpm = null;
  let bestSim = 0;
  for (const t of TEMPO_KEYS) {
    for (const k of t.keys) {
      const sim = 1 - levenshtein(r, k) / Math.max(r.length, k.length);
      if (sim > bestSim) {
        bestSim = sim;
        bestBpm = t.bpm;
      }
    }
  }
  return bestSim >= 0.62 ? bestBpm : null;
}

/** Scan a phrase for a (possibly mis-heard) tempo marking. 0 if none. */
function fuzzyTempoTerm(text) {
  for (const tok of text.split(/\s+/)) {
    const b = matchTempoToken(tok);
    if (b) return b;
  }
  return 0;
}

const BPM_MIN = 30;
const BPM_MAX = 240;
const clampBpm = (n) => Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(n)));
const clampRange = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
const VALID_DEN = [1, 2, 4, 8, 16, 32];

// --- State ---
const state = {
  bpm: 120,
  numerator: 4,
  denominator: 4,
  subdiv: 1,
  volume: 0.8,
  isPlaying: false,
  currentBeat: 0,
  currentSub: 0,
  nextNoteTime: 0,
};

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.1;

let audioCtx = null;
let masterGain = null;
let schedulerTimer = null;
const notesInQueue = [];

// --- DOM ---
const el = {
  bpm: document.querySelector(".bpm"),
  bpmValue: document.getElementById("bpmValue"),
  tempoName: document.getElementById("tempoName"),
  beats: document.getElementById("beats"),
  beatsPerBar: document.getElementById("beatsPerBar"),
  volSlider: document.getElementById("volSlider"),
  volPct: document.getElementById("volPct"),
  tapBtn: document.getElementById("tapBtn"),
  dial: document.getElementById("dial"),
  knob: document.getElementById("knob"),
  dialCenter: document.getElementById("dialCenter"),
  rampStatus: document.getElementById("rampStatus"),
  // Views / nav
  metronomeView: document.getElementById("metronomeView"),
  tunerView: document.getElementById("tunerView"),
  tabMetronome: document.getElementById("tabMetronome"),
  tabTuner: document.getElementById("tabTuner"),
  // Tuner
  tunerGauge: document.getElementById("tunerGauge"),
  tunerInstrument: document.getElementById("tunerInstrument"),
  tunerStrings: document.getElementById("tunerStrings"),
  tunerTicks: document.getElementById("tunerTicks"),
  tunerNote: document.getElementById("tunerNote"),
  tunerNoteWrap: document.getElementById("tunerNoteWrap"),
  tunerOct: document.getElementById("tunerOct"),
  tunerPrev: document.getElementById("tunerPrev"),
  tunerNext: document.getElementById("tunerNext"),
  tunerFreq: document.getElementById("tunerFreq"),
  tunerCents: document.getElementById("tunerCents"),
  tunerNeedle: document.getElementById("tunerNeedle"),
  tunerToggle: document.getElementById("tunerToggle"),
  tunerRef: document.getElementById("tunerRef"),
  tunerToneBtn: document.getElementById("tunerToneBtn"),
  gearAds: document.getElementById("gearAds"),
  presetList: document.getElementById("presetList"),
  presetSave: document.getElementById("presetSave"),
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
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.volume;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function scheduleClick(beat, sub, time) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const isMain = sub === 0;
  const isAccent = isMain && beat === 0;
  osc.frequency.value = isAccent ? 1500 : isMain ? 1000 : 1300;
  const peak = isAccent ? 0.6 : isMain ? 0.4 : 0.18;
  const dur = isMain ? 0.05 : 0.03;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(time);
  osc.stop(time + 0.06);
  notesInQueue.push({ beat, sub, time });
}

function advanceNote() {
  state.nextNoteTime += 60.0 / state.bpm / state.subdiv;
  state.currentSub += 1;
  if (state.currentSub >= state.subdiv) {
    state.currentSub = 0;
    state.currentBeat = (state.currentBeat + 1) % state.numerator;
  }
}

function scheduler() {
  while (state.nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    scheduleClick(state.currentBeat, state.currentSub, state.nextNoteTime);
    advanceNote();
  }
}

function drawLoop() {
  if (!state.isPlaying) return;
  const now = audioCtx.currentTime;
  while (notesInQueue.length && notesInQueue[0].time <= now) {
    const n = notesInQueue.shift();
    if (n.sub === 0) flashBeat(n.beat);
  }
  requestAnimationFrame(drawLoop);
}

function flashBeat(beat) {
  const dots = el.beats.children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.remove("active", "accent");
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
  state.currentSub = 0;
  state.nextNoteTime = audioCtx.currentTime + 0.05;
  notesInQueue.length = 0;
  schedulerTimer = setInterval(scheduler, LOOKAHEAD_MS);
  requestAnimationFrame(drawLoop);
  el.dialCenter.classList.add("playing");
}
function stop() {
  state.isPlaying = false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  notesInQueue.length = 0;
  for (const dot of el.beats.children) dot.classList.remove("active", "accent");
  el.dialCenter.classList.remove("playing");
  if (trainer.active) stopTrainer();
}
function toggle() {
  state.isPlaying ? stop() : start();
}

// --- BPM ---
function setBpm(bpm) {
  state.bpm = clampBpm(bpm);
  el.bpmValue.textContent = state.bpm;
  el.tempoName.textContent = tempoName(state.bpm);
  const frac = (state.bpm - BPM_MIN) / (BPM_MAX - BPM_MIN);
  el.knob.style.transform = "rotate(" + (frac * 270 - 135) + "deg)";
}

// --- Time signature & subdivision ---
function buildBeats() {
  el.beats.innerHTML = "";
  for (let i = 0; i < state.numerator; i++) {
    const dot = document.createElement("div");
    dot.className = "beat-dot";
    el.beats.appendChild(dot);
  }
}

function setTimeSignature(num, den) {
  state.numerator = Math.max(1, Math.min(12, Math.round(num)));
  state.denominator = VALID_DEN.includes(den) ? den : 4;
  state.currentBeat = 0;
  state.currentSub = 0;
  // Reflect the numerator in the dropdown when it has a matching option.
  const opt = [...el.beatsPerBar.options].find((o) => +o.value === state.numerator);
  if (opt) el.beatsPerBar.value = String(state.numerator);
  buildBeats();
}

function setSubdiv(n) {
  state.subdiv = Math.max(1, Math.min(4, Math.round(n)));
}

// --- Volume ---
function setVolume(v) {
  state.volume = Math.max(0, Math.min(1, v));
  if (masterGain) masterGain.gain.value = state.volume;
  const pct = Math.round(state.volume * 100);
  if (el.volSlider) el.volSlider.value = String(pct);
  if (el.volPct) el.volPct.textContent = (pct === 0 ? "🔇 " : "🔊 ") + pct + "%";
}

// --- Tap tempo ---
let tapTimes = [];

/** A short audible click so each tap gives feedback even when stopped. */
function tapClick() {
  ensureAudio();
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = 1200;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.05);
}

function pulseBpm() {
  if (!el.bpm) return;
  el.bpm.classList.remove("tap-flash");
  void el.bpm.offsetWidth; // restart the animation
  el.bpm.classList.add("tap-flash");
}

let tapUiTimer = null;
function tap() {
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes.shift();

  // Compute the tempo first — this is the essential reaction.
  let label = "Tap again…";
  if (tapTimes.length >= 2) {
    let total = 0;
    for (let i = 1; i < tapTimes.length; i++) total += tapTimes[i] - tapTimes[i - 1];
    setBpm(60000 / (total / (tapTimes.length - 1)));
    label = "≈ " + state.bpm + " BPM";
  }

  // Feedback — never let it block the tempo update above.
  try {
    tapClick();
  } catch (_) {}
  pulseBpm();
  if (el.tapBtn) {
    el.tapBtn.classList.add("tapping");
    el.tapBtn.textContent = label;
    clearTimeout(tapUiTimer);
    tapUiTimer = setTimeout(() => {
      el.tapBtn.classList.remove("tapping");
      el.tapBtn.textContent = "Tap tempo";
    }, 1400);
  }
}

/* ===== Voice announcements (TTS) ===== */
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
  window.speechSynthesis.speak(u);
}
function speakNumber(n) {
  speak(String(n));
}

/* ===== Speed ramp (voice) ===== */
const trainer = {
  active: false, target: 150, step: 10, interval: 30, dir: 1,
  stepTimer: null, countdown: null, remaining: 0,
};
function isRampPhrase(text) {
  if (matchAny(text, KEYWORDS.trainer)) return true;
  if (/(\d{1,3})\s*(?:to|~|–|-|에서|부터)\s*(\d{1,3})/.test(text)) return true;
  const hasStart =
    /(\d{1,3})\s*(?:부터|에서)/.test(text) || /\b(?:from|starting)\b/.test(text);
  const hasTarget = /(\d{1,3})\s*까지/.test(text) || /\b(?:to|until)\b/.test(text);
  if (hasStart && hasTarget) return true;
  if (/시작/.test(text) && /까지/.test(text)) return true;
  // Named bounds, e.g. "안단테부터 프레스토까지", "andante to presto".
  if (extractStart(text) != null && extractTarget(text) != null) return true;
  return false;
}
// Find a tempo marking sitting just before / after a marker word, so ramp
// bounds can be named — "안단테부터", "프레스토까지", "from andante", "to presto".
function tempoTermBeforeAny(text, markers) {
  for (const t of TEMPO_TERMS)
    for (const name of t.names)
      for (const mk of markers)
        if (text.includes(name + mk)) return t.bpm;
  return null;
}
function tempoTermAfterAny(text, prefixes) {
  for (const t of TEMPO_TERMS)
    for (const name of t.names)
      for (const pre of prefixes)
        if (text.includes(pre + name)) return t.bpm;
  return null;
}

// Fuzzy-match a tempo name that sits just before a Korean particle
// (모델아트부터 → moderato). `parts` are the particle spellings.
function fuzzyTempoBeforeParticle(text, parts) {
  const suffix = new RegExp("^(.+?)(?:" + parts.join("|") + ")$");
  for (const tok of text.split(/\s+/)) {
    const m = tok.match(suffix);
    if (m) {
      const b = matchTempoToken(m[1]);
      if (b) return b;
    }
  }
  return null;
}

/** Ramp start BPM from a phrase — digits or a tempo name. null if none. */
function extractStart(text) {
  let m = text.match(/(\d{1,3})\s*(?:부터|에서)/);
  if (m) return clampBpm(+m[1]);
  m = text.match(/(?:from|starting(?:\s+at)?)\s+(\d{1,3})/);
  if (m) return clampBpm(+m[1]);
  return (
    tempoTermBeforeAny(text, ["부터", "에서", " to "]) ??
    tempoTermAfterAny(text, ["from ", "starting "]) ??
    fuzzyTempoBeforeParticle(text, ["부터", "에서", "로부터"])
  );
}
/** Ramp target BPM from a phrase — digits or a tempo name. null if none. */
function extractTarget(text) {
  let m = text.match(/(\d{1,3})\s*까지/);
  if (m) return clampBpm(+m[1]);
  m = text.match(/(?:up to|\bto\b|\buntil\b|목표)\s*(\d{1,3})/);
  if (m) return clampBpm(+m[1]);
  return (
    tempoTermBeforeAny(text, ["까지"]) ??
    tempoTermAfterAny(text, ["to ", "until ", "up to "]) ??
    fuzzyTempoBeforeParticle(text, ["까지"])
  );
}

function parseTrainerConfig(text) {
  const cfg = { start: 50, target: 150, step: 10, interval: 30 };
  let m;
  if ((m = text.match(/(?:every|각|매|마다|간격)\s*(\d{1,3})/))) cfg.interval = clampRange(+m[1], 2, 600);
  if ((m = text.match(/(\d{1,3})\s*(?:초|secs?|seconds?)/))) cfg.interval = clampRange(+m[1], 2, 600);
  if ((m = text.match(/(?:by|steps?(?:\s+of)?|스텝|단계)\s*(\d{1,3})/))) cfg.step = clampRange(+m[1], 1, 60);
  if ((m = text.match(/(\d{1,3})\s*씩/))) cfg.step = clampRange(+m[1], 1, 60);
  let startN = extractStart(text);
  let targetN = extractTarget(text);
  if (startN === null || targetN === null) {
    m = text.match(/(\d{1,3})\s*(?:to|~|–|-|에서|부터)\s*(\d{1,3})/);
    if (m) {
      if (startN === null) startN = clampBpm(+m[1]);
      if (targetN === null) targetN = clampBpm(+m[2]);
    }
  }
  if (startN !== null) cfg.start = startN;
  if (targetN !== null) cfg.target = targetN;
  return cfg;
}
/**
 * While a ramp is running, pull out only the fields the user re-stated —
 * e.g. "매 7초만" → { interval: 7 }, "8씩" → { step: 8 }, "200까지" →
 * { target: 200 }. Returns { changed:false } if nothing ramp-related is found.
 */
function parseRampAdjustment(text) {
  const out = { changed: false };
  let m;
  if ((m = text.match(/(?:every|각|매|마다|간격)\s*(\d{1,3})/)) ||
      (m = text.match(/(\d{1,3})\s*(?:초|secs?|seconds?)/))) {
    out.interval = clampRange(+m[1], 2, 600);
    out.changed = true;
  }
  if ((m = text.match(/(?:by|steps?(?:\s+of)?|스텝|단계)\s*(\d{1,3})/)) ||
      (m = text.match(/(\d{1,3})\s*씩/))) {
    out.step = clampRange(+m[1], 1, 60);
    out.changed = true;
  }
  if ((m = text.match(/(\d{1,3})\s*까지/)) ||
      (m = text.match(/(?:up to|\bto\b|\buntil\b|목표)\s*(\d{1,3})/))) {
    out.target = clampBpm(+m[1]);
    out.changed = true;
  }
  return out;
}

/** Apply a partial change to the running ramp without restarting it. */
function applyRampAdjustment(adj) {
  const labels = [];
  if (adj.target !== undefined) {
    trainer.target = adj.target;
    trainer.dir = trainer.target >= state.bpm ? 1 : -1;
    labels.push("→" + adj.target);
  }
  if (adj.step !== undefined) {
    trainer.step = adj.step;
    labels.push("+" + adj.step);
  }
  if (adj.interval !== undefined) {
    trainer.interval = adj.interval;
    labels.push(adj.interval + "s");
  }
  // If the (possibly new) target is already met, finish; otherwise keep going.
  const reached =
    (trainer.dir > 0 && state.bpm >= trainer.target) ||
    (trainer.dir < 0 && state.bpm <= trainer.target);
  if (reached) {
    finishTrainer();
  } else if (adj.interval !== undefined) {
    // Restart the countdown so the new interval takes effect right away.
    clearTimers();
    scheduleNextStep();
  } else {
    renderRamp(); // refresh status with the new step / target
  }
  return labels;
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
  next = trainer.dir > 0 ? Math.min(next, trainer.target) : Math.max(next, trainer.target);
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
    `🎯 ${state.bpm} ${arrow} ${trainer.target} · +${trainer.step} · next in ${trainer.remaining}s`;
}

/* ===== Voice Control — Speech Recognition ===== */
const RECOG_LANGS = [
  ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["ko-KR", "한국어"],
  ["ja-JP", "日本語"], ["zh-CN", "中文 (简体)"], ["zh-TW", "中文 (繁體)"],
  ["es-ES", "Español"], ["fr-FR", "Français"], ["de-DE", "Deutsch"],
  ["it-IT", "Italiano"], ["pt-BR", "Português (BR)"], ["ru-RU", "Русский"],
  ["hi-IN", "हिन्दी"],
];
const KEYWORDS = {
  play: ["start", "play", "go", "begin", "resume", "run", "시작", "고", "재생",
    "플레이", "スタート", "始め", "再生", "开始", "播放", "empezar", "iniciar",
    "comenzar", "commencer", "jouer", "spielen", "avvia", "tocar", "старт", "начать"],
  stop: ["stop", "pause", "halt", "end", "quit", "정지", "멈춰", "그만", "스톱",
    "꺼", "停止", "止め", "停", "暂停", "parar", "detener", "alto", "arrêter",
    "stopp", "ferma", "стоп", "стой"],
  faster: ["faster", "speed up", "quicker", "빠르게", "빨리", "더 빨리", "速く",
    "はやく", "快", "快点", "更快", "más rápido", "rapido", "rápido", "plus vite",
    "schneller", "più veloce", "быстрее"],
  slower: ["slower", "slow down", "느리게", "천천히", "더 느리게", "遅く", "おそく",
    "慢", "慢点", "更慢", "más lento", "lento", "plus lent", "langsamer",
    "più lento", "медленнее"],
  tap: ["tap", "탭", "タップ", "点击", "toque", "taper"],
  subdiv: ["subdivision", "subdivide", "세분", "세분박", "잇단", "分割", "细分"],
  trainer: ["trainer", "train", "ramp", "훈련", "연습", "트레이너", "램프",
    "トレーナー", "練習", "训练", "练习", "entrenador", "entraîneur", "trainingsmodus"],
  reset: ["reset", "리셋", "초기화", "リセット", "重置", "reiniciar",
    "réinitialiser", "zurücksetzen"],
  // Hold at the current tempo — end the ramp but keep the click going.
  hold: ["그 템포", "그템포", "이 템포", "이템포", "현재 템포", "현재템포",
    "그 속도", "이 속도", "현재 속도", "거기서", "여기서", "그대로", "유지",
    "hold", "stay", "keep it", "keep going"],
  // Volume
  volume: ["volume", "볼륨", "소리", "音量", "volumen", "lautstärke", "볼륨을"],
  louder: ["louder", "크게", "키워", "키우", "raise", "increase", "높여", "높이"],
  quieter: ["quieter", "softer", "작게", "줄여", "줄이", "lower", "낮춰", "낮추", "decrease"],
  mute: ["mute", "음소거", "무음", "silent", "소리 꺼", "볼륨 꺼", "소리꺼"],
  maxvol: ["max volume", "full volume", "최대", "맥스", "loudest"],
  // Go to the tuner — plus common mis-hearings ("tuner"→"tuna", "tune"→"튠").
  tuner: ["tuner", "tune", "tuning", "tuna", "toona", "tooner", "tuna",
    "튜너", "튜닝", "튜나", "투나", "튠", "튜운", "튜우너", "조율",
    "チューナー", "调音", "調音", "afinador", "accordatore", "stimmgerät"],
};

// Fuzzy backup for the tuner command, since STT mangles it a lot.
const TUNER_KEYS = ["tuner", "tune", "tuning", "tuna", "tyuneo", "tyuning", "tyun", "joyul"];
function isTunerPhrase(text) {
  if (matchAny(text, KEYWORDS.tuner)) return true;
  for (const tok of text.split(/\s+/)) {
    const r = romanize(tok);
    if (r.length < 3) continue;
    for (const k of TUNER_KEYS) {
      if (1 - levenshtein(r, k) / Math.max(r.length, k.length) >= 0.7) return true;
    }
  }
  return false;
}
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

function parseBeats(text) {
  if (/waltz|왈츠|walzer|valse/.test(text)) return 3;
  const wordNums = [];
  const re = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g;
  let m;
  while ((m = re.exec(text))) wordNums.push(WORD_NUM[m[1]]);
  if (wordNums.length >= 2) return wordNums[0];
  const beatKw = /beat|signature|\btime\b|박자|拍子|拍|takt|tiempo|temps|comp[áa]s/.test(text);
  if (beatKw) {
    const dm = text.match(/(1[0-2]|[1-9])/);
    if (dm) return parseInt(dm[1], 10);
    if (wordNums.length) return wordNums[0];
  }
  return 0;
}

function parseTimeSignature(text) {
  let m;
  if ((m = text.match(/(\d{1,2})\s*분의\s*(\d{1,2})/))) return { num: +m[2], den: +m[1] };
  if ((m = text.match(/\b([1-9]\d?)\s*\/\s*([1-9]\d?)\b/))) return { num: +m[1], den: +m[2] };
  if (/waltz|왈츠|walzer|valse/.test(text)) return { num: 3, den: 4 };
  const beats = parseBeats(text);
  if (beats) return { num: beats, den: 4 };
  return null;
}

// English number words → digits, so spoken numbers work in any mix of
// language/notation: "one twenty" → 120, "one fifty" → 150, "forty five" → 45,
// "two hundred" → 200, "five" → 5.
const NUM_WORD_VALUE = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};
const NUM_WORDS_RE = new RegExp(
  "\\b(?:" +
    Object.keys(NUM_WORD_VALUE).sort((a, b) => b.length - a.length).join("|") +
    ")(?:[\\s-]+(?:" +
    Object.keys(NUM_WORD_VALUE).sort((a, b) => b.length - a.length).join("|") +
    "))*\\b",
  "gi"
);

function wordsToNum(tokens) {
  // Colloquial hundreds: "one twenty" = 120, "two thirty five" = 235.
  if (tokens.length >= 2) {
    const v0 = NUM_WORD_VALUE[tokens[0]];
    const v1 = NUM_WORD_VALUE[tokens[1]];
    if (v0 >= 1 && v0 <= 9 && v1 >= 10 && tokens[1] !== "hundred" && tokens[1] !== "thousand") {
      let rest = 0;
      for (let i = 1; i < tokens.length; i++) rest += NUM_WORD_VALUE[tokens[i]] || 0;
      return v0 * 100 + rest;
    }
  }
  // Standard: "one hundred twenty" = 120, "forty five" = 45.
  let total = 0;
  let current = 0;
  for (const t of tokens) {
    if (t === "hundred") current = (current || 1) * 100;
    else if (t === "thousand") { total += (current || 1) * 1000; current = 0; }
    else current += NUM_WORD_VALUE[t];
  }
  return total + current;
}

// Korean speech recognition transcribes spoken English phonetically into
// hangul ("five" → "파이브", "one fifty" → "원피프티"). Map those loanword
// spellings back to English words so the converter above can read them. Values
// are English so the colloquial-hundreds logic still applies ("one fifty" →
// 150). Keys are foreign loanwords that don't collide with Korean command words.
const HANGUL_EN = {
  // Single-syllable readings (원/투/포…) are intentionally omitted: they
  // collide with common Korean words (템포, 원래, 투자). Korean numbers are
  // handled by the Sino-Korean pass instead.
  쓰리: "three", 트리: "three",
  파이브: "five", 식스티: "sixty", 식스: "six", 세븐티: "seventy",
  세븐: "seven", 에이티: "eighty", 에잇: "eight", 에이트: "eight",
  나인티: "ninety", 나인: "nine", 텐: "ten", 일레븐: "eleven",
  트웰브: "twelve", 투엔티: "twenty", 트웨니: "twenty", 트웬티: "twenty",
  써티: "thirty", 서티: "thirty", 포티: "forty", 훠티: "forty",
  피프티: "fifty", 헌드레드: "hundred", 헌드렛: "hundred",
  에브리: "every", 세컨드: "second", 세컨트: "second", 세컨: "second",
};
const HANGUL_EN_RE = new RegExp(
  Object.keys(HANGUL_EN).sort((a, b) => b.length - a.length).join("|"),
  "g"
);

// Sino-Korean numerals (native metronome range) → value. No 천(1000): tempos
// never reach it and it collides with common words (천천히, 천장…).
const SINO = {
  영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6,
  칠: 7, 팔: 8, 구: 9, 십: 10, 백: 100,
};
function sinoToNum(s) {
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    const v = SINO[ch];
    if (v == null) return null;
    if (v >= 10) { total += (cur || 1) * v; cur = 0; }
    else cur = v;
  }
  return total + cur;
}

/** Normalize spoken numbers (English words + Korean spellings) to digits. */
function normalizeNumbers(text) {
  // Loanword hangul → English words (space-padded so concatenations split).
  let t = text.replace(HANGUL_EN_RE, (m) => " " + HANGUL_EN[m] + " ");
  // English number words → digits.
  t = t.replace(NUM_WORDS_RE, (m) => {
    const toks = m.toLowerCase().split(/[\s-]+/).filter(Boolean);
    const n = wordsToNum(toks);
    return Number.isFinite(n) ? String(n) : m;
  });
  // Colloquial hundreds that STT split apart: "one thirty" often comes back as
  // "1 30", "1:30", or "1.30" → 130, "2 40" → 240.
  t = t.replace(/\b([1-9])[\s:.]+(\d{2})\b/g, (m, a, b) => String(+a * 100 + +b));
  // Sino-Korean numbers — only a whole token containing a place digit
  // (십/백) and bounded by a space/particle, so words like "천천히" or the
  // "이 템포" hold command are never corrupted.
  t = t.replace(
    /(^|\s)([영공일이삼사오육륙칠팔구십백]+)(?=$|\s|부터|에서|까지|씩|초|으로|로|템포|비피엠|bpm)/g,
    (m, pre, run) => {
      if (!/[십백]/.test(run)) return m;
      const n = sinoToNum(run);
      return n != null && n >= 1 ? pre + n : m;
    }
  );
  return t;
}

let recognition = null;
let listening = false;
let recogRunning = false;
function matchAny(text, list) {
  return list.some((kw) => text.includes(kw));
}
function flashCmd(label) {
  el.vcCmd.textContent = label;
  el.vcCmd.classList.remove("flash");
  void el.vcCmd.offsetWidth;
  el.vcCmd.classList.add("flash");
}

function handleTranscript(raw) {
  const text = raw.toLowerCase().trim();
  // Number-normalized copy: "one twenty" → "120", "five" → "5". Used for every
  // number-sensitive command; time signatures use the original text so word
  // pairs like "three four" stay 3/4 instead of becoming a single number.
  const ntext = normalizeNumbers(text);
  el.vcHeard.textContent = "“" + raw.trim() + "”";

  // Go to the tuner ("튜너로 가줘", "tune 할거야"). Voice turns off there.
  if (isTunerPhrase(text)) {
    flashCmd("→ Tuner");
    showView("tuner");
    return;
  }

  if (matchAny(text, KEYWORDS.reset)) {
    stopTrainer();
    setBpm(120);
    setTimeSignature(4, 4);
    setSubdiv(1);
    flashCmd("Reset");
    return;
  }

  // Volume — "volume up/down", "볼륨 50", "louder"/"quieter", "mute". Direction
  // words (up/올려…) only count as volume when a volume word is present, so the
  // ramp's "올려줘" isn't hijacked.
  if (matchAny(text, KEYWORDS.mute)) {
    ensureAudio();
    setVolume(0);
    flashCmd("🔇 Muted");
    return;
  }
  const wantsVolume = matchAny(text, KEYWORDS.volume);
  if (wantsVolume || matchAny(text, KEYWORDS.louder) || matchAny(text, KEYWORDS.quieter)) {
    ensureAudio();
    const numM = wantsVolume ? ntext.match(/(\d{1,3})/) : null;
    const up = matchAny(text, KEYWORDS.louder) || (wantsVolume && /(\bup\b|올려|올림|업)/.test(text));
    const down = matchAny(text, KEYWORDS.quieter) || (wantsVolume && /(\bdown\b|내려|내림|다운)/.test(text));
    if (matchAny(text, KEYWORDS.maxvol)) setVolume(1);
    else if (numM) setVolume(+numM[1] / 100);
    else if (down) setVolume(state.volume - 0.1);
    else if (up) setVolume(state.volume + 0.1);
    flashCmd("🔊 " + Math.round(state.volume * 100) + "%");
    return;
  }
  // Intelligent handling while a ramp is RUNNING.
  if (trainer.active) {
    const startN = extractStart(ntext);
    const targetN = extractTarget(ntext);
    const adj = parseRampAdjustment(ntext);

    // "그 템포에서 멈춰" — stop climbing but keep playing at the current tempo.
    if (matchAny(text, KEYWORDS.hold)) {
      const bpm = state.bpm;
      stopTrainer();
      flashCmd("Hold · " + bpm);
      return;
    }
    // Bare "trainer" / "ramp" with nothing else — end the ramp.
    if (matchAny(text, KEYWORDS.trainer) && startN == null && targetN == null && !adj.changed) {
      stopTrainer();
      flashCmd("Ramp ■");
      return;
    }
    // "50부터 다시" — jump to a new start, keep the same target/step/interval.
    if (startN != null && targetN == null) {
      if (adj.step !== undefined) trainer.step = adj.step;
      if (adj.interval !== undefined) trainer.interval = adj.interval;
      trainer.dir = trainer.target >= startN ? 1 : -1;
      setBpm(startN);
      clearTimers();
      speakNumber(startN);
      if (state.bpm === trainer.target) finishTrainer();
      else scheduleNextStep();
      flashCmd("Ramp ↻ " + startN + "→" + trainer.target);
      return;
    }
    // A new full range — restart the ramp.
    if (startN != null && targetN != null) {
      const cfg = parseTrainerConfig(ntext);
      stopTrainer();
      startTrainer(cfg);
      flashCmd(`Ramp ▶ ${cfg.start}→${cfg.target}`);
      return;
    }
    // Only interval / step / target restated — adjust in place.
    if (adj.changed) {
      const labels = applyRampAdjustment(adj);
      flashCmd("Ramp · " + labels.join(" "));
      return;
    }
  }

  // Start a new ramp (not running, or nothing above matched).
  if (isRampPhrase(ntext)) {
    const cfg = parseTrainerConfig(ntext);
    if (trainer.active) stopTrainer();
    startTrainer(cfg);
    flashCmd(`Ramp ▶ ${cfg.start}→${cfg.target}`);
    return;
  }
  if (matchAny(text, KEYWORDS.subdiv)) {
    const m = ntext.match(/([1-4])/);
    setSubdiv(m ? +m[1] : (state.subdiv % 4) + 1);
    flashCmd("Sub · " + state.subdiv);
    return;
  }
  const ts = parseTimeSignature(text);
  if (ts) {
    setTimeSignature(ts.num, ts.den);
    flashCmd("Time · " + state.numerator + "/" + state.denominator);
    return;
  }
  const num = ntext.match(/\d{2,3}/);
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
  const term = parseTempoTerm(text);
  if (term) {
    stopTrainer();
    setBpm(term);
    if (!state.isPlaying) start();
    flashCmd(tempoName(term) + " · " + term);
    return;
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
  // Last resort: a mis-transcribed tempo marking ("moderato" → "모델아트").
  const fz = fuzzyTempoTerm(text);
  if (fz) {
    stopTrainer();
    setBpm(fz);
    if (!state.isPlaying) start();
    flashCmd(tempoName(fz) + " · " + fz);
    return;
  }
  flashCmd("—");
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
  const loose = RECOG_LANGS.find(([c]) => c.toLowerCase().startsWith(bl.split("-")[0]));
  if (exact) el.vcLang.value = exact[0];
  else if (loose) el.vcLang.value = loose[0];
}

/* =========================================================================
 * Native speech recognition (Capacitor) — far better recognition (echo
 * cancellation, gain, on-device) in the packaged app. In a plain browser this
 * stays inactive and the Web Speech API path below runs unchanged.
 * ========================================================================= */
const CAP = window.Capacitor;
const IS_NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
let NativeSR = null;
let nativeResolveNote = "";

/** Resolve the native SpeechRecognition plugin. Tries the modern
 *  registerPlugin() proxy first, then the legacy Capacitor.Plugins map, and
 *  is safe to call repeatedly (handles bridge/plugin load-order races). */
function resolveNativeSR() {
  if (NativeSR) return NativeSR;
  if (!CAP) { nativeResolveNote = "no Capacitor"; return null; }
  try {
    if (typeof CAP.registerPlugin === "function") {
      NativeSR = CAP.registerPlugin("SpeechRecognition");
      nativeResolveNote = "registerPlugin";
    } else if (CAP.Plugins && CAP.Plugins.SpeechRecognition) {
      NativeSR = CAP.Plugins.SpeechRecognition;
      nativeResolveNote = "Plugins map";
    } else {
      nativeResolveNote =
        "regFn=" + typeof CAP.registerPlugin + " plugins=" + !!CAP.Plugins;
    }
  } catch (e) {
    NativeSR = null;
    nativeResolveNote = "threw:" + (e && e.message ? e.message : e);
  }
  return NativeSR;
}
resolveNativeSR();
let nativeWired = false;
let lastNativePartial = "";
let nativePermNote = "";
let nativeEventCount = 0;

/** Developer diagnostics → console only (kept off the UI so users never see
 *  "granted"/permission internals). */
function diag(msg) {
  try { console.log("[voice] " + msg); } catch (_) {}
}
const PLATFORM = (CAP && CAP.getPlatform && CAP.getPlatform()) || "web";
function errText(e) {
  if (!e) return "unknown";
  if (typeof e === "string") return e;
  return (e.name ? e.name + ": " : "") + (e.message || JSON.stringify(e));
}

/** Immediate reaction to the two idempotent transport commands (shared by the
 *  web interim path and the native partial-results path). */
function handleInterim(raw) {
  const t = raw.toLowerCase();
  if (matchAny(t, KEYWORDS.stop)) {
    if (state.isPlaying) {
      stop();
      el.vcHeard.textContent = "“" + raw.trim() + "”";
      flashCmd("Stop");
    }
  } else if (matchAny(t, KEYWORDS.play)) {
    if (!state.isPlaying) {
      start();
      el.vcHeard.textContent = "“" + raw.trim() + "”";
      flashCmd("Play");
    }
  }
}

let nativeStarting = false;
let lastNativeActivity = 0;
let nativeWatchdog = null;
function nativeBump() {
  lastNativeActivity = Date.now();
}

/** Run one recognition session and WAIT for its result. On this class of device
 *  partialResults:true never emits interim events, so we use the reliable mode:
 *  start() resolves with the final matches (or rejects on NO_MATCH/timeout),
 *  we handle the phrase, then re-arm as fast as the engine allows. A watchdog
 *  backstops a missed end-event so the loop can't wedge. Android's per-session
 *  endpointing means a tiny gap between sessions is unavoidable. */
function nativeStartOnce() {
  if (!NativeSR || nativeStarting) return;
  nativeStarting = true;
  nativeBump();
  NativeSR.start({
    language: el.vcLang.value,
    maxResults: 3,
    partialResults: false,
    popup: false,
  })
    .then((res) => {
      nativeStarting = false;
      nativeEventCount++;
      nativeBump();
      const m = res && res.matches;
      if (m && m.length) {
        el.vcHeard.textContent = "“" + m[0].trim() + "”";
        handleTranscript(m[0]);
        lastNativePartial = "";
      }
      // Give the recognizer time to fully release before the next session —
      // restarting too fast is what triggers the RECOGNIZER_BUSY oscillation.
      if (listening && !tunerActive) setTimeout(nativeStartOnce, 500);
    })
    .catch((e) => {
      nativeStarting = false;
      nativeEventCount++;
      nativeBump();
      const msg = errText(e);
      // Still not released — DON'T stop() (that churns it more); just wait longer.
      if (/busy/i.test(msg)) {
        if (listening && !tunerActive) setTimeout(nativeStartOnce, 1000);
        return;
      }
      // NO_MATCH / SPEECH_TIMEOUT during silence are expected — just re-listen.
      // Surface anything genuinely unusual.
      if (!/no match|timeout|no speech|didn'?t understand|client/i.test(msg))
        diag("STT: " + msg);
      if (listening && !tunerActive) setTimeout(nativeStartOnce, 400);
    });
}

/** Self-heal net. Android's SpeechRecognizer wedges after a number of
 *  start/stop cycles: start() then hangs forever (nativeStarting stuck true) and
 *  no result/error ever comes — the "works ~10 times then dies" symptom. A
 *  manual language switch revived it because it calls stop(), which forces the
 *  hung session to release. So: if the engine has been silent past Android's
 *  normal silence timeout, force stop() (even mid-"starting") and restart fresh.
 *  Crucially this does NOT bail on nativeStarting — that guard is exactly what
 *  let a wedged session sit dead. */
function ensureNativeWatchdog() {
  if (nativeWatchdog) return;
  nativeWatchdog = setInterval(() => {
    if (!listening || tunerActive) return;
    if (Date.now() - lastNativeActivity > 7000) {
      nativeBump(); // reset timer so we don't hammer while it recovers
      nativeStarting = false;
      try { NativeSR.stop(); } catch (_) {}
      setTimeout(() => {
        if (listening && !tunerActive && !nativeStarting) nativeStartOnce();
      }, 400);
    }
  }, 2000);
}

async function startNative() {
  try {
    diag("Voice: checking native engine…");
    // 1) Is the on-device recognizer present?
    try {
      const a = await NativeSR.available();
      if (a && a.available === false) {
        diag("No speech recognizer on this device. Install/enable Google app voice.");
        listening = false;
        setMicUI(false);
        return;
      }
    } catch (e) {
      diag("available() failed: " + errText(e));
    }
    // 2) Microphone permission — surface the raw check + request results so the
    //    true permission state is visible on-device (not just our guess).
    let perm, checkBefore;
    try { checkBefore = await NativeSR.checkPermissions(); } catch (_) {}
    try {
      perm = await NativeSR.requestPermissions();
    } catch (e) {
      diag("Permission request failed: " + errText(e));
      listening = false;
      setMicUI(false);
      return;
    }
    nativePermNote =
      "check=" + JSON.stringify(checkBefore || null) + " req=" + JSON.stringify(perm || null);
    const granted = perm && (perm.speechRecognition === "granted" || perm.record === "granted" || perm.granted === true);
    if (perm && !granted) {
      diag("Mic NOT granted → " + nativePermNote + " · enable Microphone in Settings.");
      listening = false;
      setMicUI(false);
      return;
    }
    // 3) Wire event listeners once.
    if (!nativeWired) {
      nativeWired = true;
      NativeSR.addListener("partialResults", (d) => {
        nativeEventCount++;
        nativeBump();
        const m = d && d.matches;
        if (m && m.length) {
          lastNativePartial = m[0];
          el.vcHeard.textContent = "“" + m[0].trim() + "”";
          handleInterim(m[0]); // instant stop/play while the session is live
        }
      });
      NativeSR.addListener("listeningState", (d) => {
        nativeEventCount++;
        nativeBump();
        // Re-arm is driven solely by the start() promise loop; re-arming here
        // too caused overlapping sessions → RECOGNIZER_BUSY. Observe only.
        void d;
      });
    }
    ensureNativeWatchdog();
    listening = true;
    setMicUI(true);
    diag("Listening… " + nativePermNote);
    // Clean slate before the first pass. Coming back from the tuner (which held
    // the mic) can leave a half-open session that would otherwise wedge the
    // restart loop (nativeStarting stuck true) — stop, then start fresh.
    nativeStarting = false;
    try { await NativeSR.stop(); } catch (_) {}
    setTimeout(nativeStartOnce, 500);
    // Heartbeat: if no recognizer events arrive within a few seconds the mic
    // isn't feeding the engine (usually an OS permission the WebView didn't get).
    setTimeout(() => {
      if (listening && !tunerActive && nativeEventCount === 0) {
        diag("No recognizer events (8s) → engine not returning. " + nativePermNote);
      }
    }, 8000);
  } catch (e) {
    diag("Native start failed: " + errText(e));
    listening = false;
    setMicUI(false);
  }
}

async function stopNative() {
  listening = false;
  nativeStarting = false;
  try {
    await NativeSR.stop();
  } catch (_) {}
  setMicUI(false);
  if (el.vcHeard) el.vcHeard.textContent = "Mic off"; // clear any diag banner
}

function initRecognition() {
  if (NativeSR) return; // native handles recognition
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
  // Interim results let us react to short transport commands instantly instead
  // of waiting for the engine to finalize the phrase (removes the lag).
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    const raw = result[0].transcript;
    if (result.isFinal) {
      handleTranscript(raw);
      return;
    }
    handleInterim(raw); // fast path for stop/play on partial results
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      listening = false;
      setMicUI(false);
      el.vcHeard.innerHTML =
        '<span class="vc-unsupported">Microphone permission denied.</span>';
    }
  };
  recognition.onstart = () => {
    recogRunning = true;
  };
  recognition.onend = () => {
    recogRunning = false;
    if (listening && !tunerActive) {
      try {
        recognition.start();
      } catch (_) {}
    }
  };
}
function setMicUI(on) {
  el.micBtn.classList.toggle("listening", on);
  el.micBtn.textContent = on ? "🛑 Stop" : "🎤 Start";
  if (on) el.vcHeard.textContent = "Listening… say a command";
  else if (!el.vcHeard.querySelector(".vc-unsupported")) el.vcHeard.textContent = "Mic off";
}
function startListening() {
  if (resolveNativeSR()) {
    startNative();
    return;
  }
  if (!recognition) return;
  ensureAudio();
  recognition.lang = el.vcLang.value;
  listening = true;
  try {
    recognition.start();
  } catch (_) {}
  setMicUI(true);
  // If we're inside the packaged app but landed on the (unsupported) web
  // recognizer, the native plugin isn't wired — surface that instead of a
  // silent dead mic.
  if (IS_NATIVE) diag("Web recognizer on native — plugin missing (native=" + IS_NATIVE + ")");
}
function stopListening() {
  if (NativeSR) {
    stopNative();
    return;
  }
  listening = false;
  if (recognition) recognition.stop();
  setMicUI(false);
}
function toggleListening() {
  listening ? stopListening() : startListening();
}

/* ===== iPod-style click wheel ===== */
let dragging = false;
let lastAngle = 0;
let angleAccum = 0;
const DEG_PER_BPM = 3;
function angleAt(e) {
  const r = el.dial.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
}
function onDialDown(e) {
  dragging = true;
  angleAccum = 0;
  lastAngle = angleAt(e);
  el.dial.setPointerCapture(e.pointerId);
  el.dial.classList.add("turning");
}
function onDialMove(e) {
  if (!dragging) return;
  const a = angleAt(e);
  let d = a - lastAngle;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  lastAngle = a;
  angleAccum += d;
  const steps = Math.trunc(angleAccum / DEG_PER_BPM);
  if (steps) {
    angleAccum -= steps * DEG_PER_BPM;
    if (trainer.active) stopTrainer();
    setBpm(state.bpm + steps);
  }
}
function onDialUp() {
  dragging = false;
  el.dial.classList.remove("turning");
}

/* ===== Events ===== */
el.dial.addEventListener("pointerdown", onDialDown);
el.dial.addEventListener("pointermove", onDialMove);
el.dial.addEventListener("pointerup", onDialUp);
el.dial.addEventListener("pointercancel", onDialUp);
el.dialCenter.addEventListener("pointerdown", (e) => e.stopPropagation());
el.dialCenter.addEventListener("click", (e) => {
  e.stopPropagation();
  toggle();
});

document.querySelectorAll(".nudge-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (trainer.active) stopTrainer();
    setBpm(state.bpm + Number(btn.dataset.delta));
  });
});

el.beatsPerBar.addEventListener("change", (e) => {
  setTimeSignature(Number(e.target.value), state.denominator);
});

el.volSlider.addEventListener("input", (e) => {
  ensureAudio();
  setVolume(Number(e.target.value) / 100);
});
el.tapBtn.addEventListener("click", tap);
el.micBtn.addEventListener("click", toggleListening);
el.vcLang.addEventListener("change", () => {
  if (!listening) return;
  if (NativeSR) NativeSR.stop().catch(() => {}); // listeningState restarts with the new lang
  else if (recognition) recognition.stop();
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

/* =========================================================================
 * Tuner — chromatic pitch detection from the microphone (autocorrelation).
 * Voice control is turned off while tuning so the mic is free for pitch.
 * ========================================================================= */
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
let tunerStream = null;
let tunerAnalyser = null;
let tunerBuf = null;
let tunerRAF = null;
let tunerActive = false;

// Standard instrument tunings as MIDI note numbers (low → high string).
const INSTRUMENTS = {
  guitar: [40, 45, 50, 55, 59, 64], // E2 A2 D3 G3 B3 E4
  bass: [28, 33, 38, 43],           // E1 A1 D2 G2
  ukulele: [67, 60, 64, 69],        // G4 C4 E4 A4 (reentrant)
  violin: [55, 62, 69, 76],         // G3 D4 A4 E5
  viola: [48, 55, 62, 69],          // C3 G3 D4 A4
  cello: [36, 43, 50, 57],          // C2 G2 D3 A3
};
let tunerStrings = null; // active string MIDI list, or null = chromatic
let tunerRefA = 441;     // reference pitch for A4 (Hz)
const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// Reference A tone generator (tune by ear).
let toneOsc = null;
let toneGain = null;
function startTone() {
  ensureAudio();
  stopTone();
  toneOsc = audioCtx.createOscillator();
  toneGain = audioCtx.createGain();
  toneOsc.type = "sine";
  toneOsc.frequency.value = tunerRefA; // A4
  toneGain.gain.value = 0.0001;
  toneOsc.connect(toneGain);
  toneGain.connect(audioCtx.destination);
  toneOsc.start();
  toneGain.gain.exponentialRampToValueAtTime(0.22, audioCtx.currentTime + 0.03);
  el.tunerToneBtn.textContent = "■ Stop A";
  el.tunerToneBtn.classList.add("playing");
}
function stopTone() {
  if (!toneOsc) return;
  try {
    toneGain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
    toneOsc.stop(audioCtx.currentTime + 0.07);
  } catch (_) {}
  toneOsc = null;
  toneGain = null;
  el.tunerToneBtn.textContent = "♪ Play A";
  el.tunerToneBtn.classList.remove("playing");
}
function toggleTone() {
  toneOsc ? stopTone() : startTone();
}

function setInstrument(key) {
  renderGear(key);
  tunerStrings = INSTRUMENTS[key] || null;
  const chips = el.tunerStrings;
  chips.innerHTML = "";
  if (!tunerStrings) {
    chips.hidden = true;
    return;
  }
  chips.hidden = false;
  tunerStrings.forEach((m) => {
    const chip = document.createElement("span");
    chip.className = "tuner-chip";
    chip.dataset.midi = String(m);
    chip.textContent = midiName(m);
    chips.appendChild(chip);
  });
}

function highlightString(targetMidi, inTune) {
  for (const chip of el.tunerStrings.children) {
    const active = Number(chip.dataset.midi) === targetMidi;
    chip.classList.toggle("active", active);
    chip.classList.toggle("in-tune", active && inTune);
  }
}

/* =========================================================================
 * Contextual gear recommendations (affiliate). Small strip that reflects the
 * chosen instrument. Put your Amazon Associates tag in AFFILIATE_TAG and every
 * link earns commission on a purchase; until then the links still work with no
 * tag. Swap amzn() for another store's affiliate URL scheme if you prefer.
 * ========================================================================= */
// Per-marketplace Amazon domains + your Associates tag for each. Fill in the
// tags for the marketplaces you've joined (each Amazon country is a separate
// Associates account); a blank tag still links, just without commission.
const AMAZON = {
  AU: { host: "amazon.com.au", tag: "" },
  US: { host: "amazon.com", tag: "" },
  GB: { host: "amazon.co.uk", tag: "" },
  CA: { host: "amazon.ca", tag: "" },
  DE: { host: "amazon.de", tag: "" },
  FR: { host: "amazon.fr", tag: "" },
  IT: { host: "amazon.it", tag: "" },
  ES: { host: "amazon.es", tag: "" },
  JP: { host: "amazon.co.jp", tag: "" },
  IN: { host: "amazon.in", tag: "" },
  NL: { host: "amazon.nl", tag: "" },
  SG: { host: "amazon.sg", tag: "" },
};
const AMAZON_DEFAULT = "US"; // fallback marketplace when region is unknown

/** Best-effort country from timezone (strongest location signal) then locale. */
function detectCountry() {
  let cc = null;
  const m = (navigator.language || "").match(/[-_]([A-Za-z]{2})\b/);
  if (m) cc = m[1].toUpperCase();
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (tz.startsWith("Australia/")) cc = "AU";
    else if (tz === "Europe/London") cc = "GB";
    else if (tz === "Asia/Tokyo") cc = "JP";
    else if (tz === "Asia/Kolkata") cc = "IN";
    else if (tz === "Asia/Singapore") cc = "SG";
    else if (["Europe/Berlin", "Europe/Amsterdam", "Europe/Paris", "Europe/Madrid", "Europe/Rome"].includes(tz)) {
      cc = { "Europe/Berlin": "DE", "Europe/Amsterdam": "NL", "Europe/Paris": "FR", "Europe/Madrid": "ES", "Europe/Rome": "IT" }[tz];
    } else if (tz === "America/Toronto" || tz === "America/Vancouver" || tz === "America/Edmonton") cc = "CA";
    else if (/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Indiana)/.test(tz)) cc = "US";
  } catch (_) {}
  return cc && AMAZON[cc] ? cc : AMAZON_DEFAULT;
}
const AMAZON_CC = detectCountry();

function amzn(query) {
  const store = AMAZON[AMAZON_CC] || AMAZON[AMAZON_DEFAULT];
  const tag = store.tag ? "&tag=" + encodeURIComponent(store.tag) : "";
  return "https://www." + store.host + "/s?k=" + encodeURIComponent(query) + tag;
}
const GEAR = {
  default: [["Metronome", "metronome"], ["Music stand", "sheet music stand"], ["Clip tuner", "clip on tuner"], ["Earplugs", "musician earplugs"]],
  guitar: [["Strings", "acoustic guitar strings"], ["Capo", "guitar capo"], ["Picks", "guitar picks"], ["Stand", "guitar stand"]],
  bass: [["Strings", "bass guitar strings"], ["Gig bag", "bass guitar gig bag"], ["Cable", "instrument cable"], ["Strap", "bass strap"]],
  ukulele: [["Strings", "ukulele strings"], ["Case", "ukulele case"], ["Capo", "ukulele capo"], ["Strap", "ukulele strap"]],
  violin: [["Rosin", "violin rosin"], ["Shoulder rest", "violin shoulder rest"], ["Strings", "violin strings"], ["Chin rest", "violin chin rest"]],
  viola: [["Rosin", "viola rosin"], ["Shoulder rest", "viola shoulder rest"], ["Strings", "viola strings"], ["Case", "viola case"]],
  cello: [["Rosin", "cello rosin"], ["Strings", "cello strings"], ["Endpin stop", "cello endpin stopper"], ["Bow", "cello bow"]],
};
const SHOW_GEAR = false; // affiliate strip off for the newsletter launch
function renderGear(key) {
  if (!SHOW_GEAR) {
    el.gearAds.hidden = true;
    return;
  }
  const items = GEAR[key] || GEAR.default;
  el.gearAds.innerHTML =
    '<span class="gear-tag">Ad</span>' +
    items
      .map(
        ([label, q]) =>
          '<a class="gear-item" target="_blank" rel="noopener sponsored" href="' +
          amzn(q) + '">' + label + "</a>"
      )
      .join("");
}

/** Returns { freq, clarity } — clarity is the autocorrelation peak relative to
 *  the signal's own energy (0..1). Low clarity = noise, not a real pitch. */
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.004) return { freq: -1, clarity: 0 }; // too quiet

  let r1 = 0;
  let r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++)
    if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++)
    if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }

  const b = buf.slice(r1, r2);
  const n = b.length;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n - i; j++) c[i] += b[j] * b[j + i];

  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1;
  let maxpos = -1;
  for (let i = d; i < n; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  let T0 = maxpos;
  if (T0 <= 0) return { freq: -1, clarity: 0 };

  const clarity = c[0] > 0 ? maxval / c[0] : 0;

  const x1 = c[T0 - 1] || 0;
  const x2 = c[T0];
  const x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2;
  const bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);

  const freq = sampleRate / T0;
  return { freq: freq > 25 && freq < 4500 ? freq : -1, clarity };
}

/** Build the gauge tick marks once (−50..+50 cents across a 110° arc). */
function buildTunerGauge() {
  if (!el.tunerTicks || el.tunerTicks.childNodes.length) return;
  const cx = 100, cy = 108, rOuter = 84, ns = "http://www.w3.org/2000/svg";
  for (let cent = -50; cent <= 50; cent += 5) {
    const major = cent % 25 === 0;
    const ang = (cent / 50) * 55 * (Math.PI / 180); // radians from vertical
    const len = major ? 14 : 8;
    const x1 = cx + Math.sin(ang) * rOuter;
    const y1 = cy - Math.cos(ang) * rOuter;
    const x2 = cx + Math.sin(ang) * (rOuter - len);
    const y2 = cy - Math.cos(ang) * (rOuter - len);
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", x1.toFixed(1));
    line.setAttribute("y1", y1.toFixed(1));
    line.setAttribute("x2", x2.toFixed(1));
    line.setAttribute("y2", y2.toFixed(1));
    line.setAttribute("class", "tuner-tick" + (cent === 0 ? " zero" : major ? " major" : ""));
    el.tunerTicks.appendChild(line);
  }
}

function setNeedle(cents) {
  const ang = (Math.max(-50, Math.min(50, cents)) / 50) * 55;
  el.tunerNeedle.setAttribute("transform", "rotate(" + ang.toFixed(1) + " 100 108)");
}

function updateTunerDisplay(freq) {
  const noteNum = 12 * Math.log2(freq / tunerRefA) + 69;
  // In instrument mode, snap to the nearest open string; else nearest semitone.
  const target = tunerStrings
    ? tunerStrings.reduce((best, m) =>
        Math.abs(m - noteNum) < Math.abs(best - noteNum) ? m : best, tunerStrings[0])
    : Math.round(noteNum);
  const cents = Math.round((noteNum - target) * 100);
  const inTune = Math.abs(cents) <= 5;

  el.tunerNote.textContent = NOTE_NAMES[((target % 12) + 12) % 12];
  el.tunerOct.textContent = Math.floor(target / 12) - 1;
  el.tunerPrev.textContent = NOTE_NAMES[(((target - 1) % 12) + 12) % 12];
  el.tunerNext.textContent = NOTE_NAMES[(((target + 1) % 12) + 12) % 12];
  el.tunerFreq.textContent = freq.toFixed(1) + " Hz";
  el.tunerCents.textContent = (cents > 0 ? "+" : "") + cents + "¢";
  setNeedle(cents);
  el.tunerGauge.classList.toggle("in-tune", inTune);
  if (tunerStrings) highlightString(target, inTune);
}

function showTunerIdle() {
  el.tunerNote.textContent = "–";
  el.tunerOct.textContent = "";
  el.tunerPrev.textContent = "";
  el.tunerNext.textContent = "";
  el.tunerCents.textContent = "–";
  el.tunerFreq.textContent = "Listening…";
  setNeedle(0);
  el.tunerGauge.classList.remove("in-tune");
  if (tunerStrings) highlightString(-1, false);
}

// Detection smoothing / note-hold so the readout doesn't flicker.
let tunerSmoothed = 0;
let tunerLastGood = 0;
const TUNER_CLARITY = 0.46;   // below this = noise, ignore
const TUNER_HOLD_MS = 700;    // keep the last note through brief dropouts

function tunerLoop() {
  if (!tunerActive || !tunerAnalyser) return;
  tunerAnalyser.getFloatTimeDomainData(tunerBuf);
  const { freq, clarity } = autoCorrelate(tunerBuf, audioCtx.sampleRate);
  const now = performance.now();
  if (freq > 0 && clarity >= TUNER_CLARITY) {
    // Snap on a real note change (>60 cents); otherwise glide for stability.
    if (!tunerSmoothed || Math.abs(1200 * Math.log2(freq / tunerSmoothed)) > 60)
      tunerSmoothed = freq;
    else tunerSmoothed = tunerSmoothed * 0.78 + freq * 0.22;
    tunerLastGood = now;
    updateTunerDisplay(tunerSmoothed);
  } else if (now - tunerLastGood > TUNER_HOLD_MS) {
    tunerSmoothed = 0;
    showTunerIdle();
  }
  tunerRAF = requestAnimationFrame(tunerLoop);
}

async function startTuner() {
  try {
    tunerActive = true; // claim the mic now so the voice loop won't re-grab it
    ensureAudio(); // resumes the AudioContext inside the tab-tap gesture
    // In the packaged app, make sure the OS mic permission is granted before the
    // WebView asks for it — otherwise getUserMedia is denied outright.
    if (resolveNativeSR()) {
      try { await NativeSR.requestPermissions(); } catch (_) {}
    }
    // Voice recognition may have just released the mic; grabbing it in the same
    // instant yields a silent stream (stuck on "Listening…"). Give it a beat,
    // and make sure the context is actually running.
    await new Promise((r) => setTimeout(r, 350));
    if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch (_) {} }
    tunerStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = audioCtx.createMediaStreamSource(tunerStream);
    // Phone mics carry a lot of sub-audible rumble/DC that hijacks the
    // autocorrelation (it locks onto a huge lag → no valid pitch). A high-pass
    // clears it; a gentle low-pass tames hiss above the instrument range.
    const hp = audioCtx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 60;
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2000;
    tunerAnalyser = audioCtx.createAnalyser();
    tunerAnalyser.fftSize = 2048;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(tunerAnalyser);
    tunerBuf = new Float32Array(tunerAnalyser.fftSize);
    tunerActive = true;
    tunerSmoothed = 0;
    tunerLastGood = 0;
    buildTunerGauge();
    el.tunerToggle.textContent = "Stop Tuner";
    el.tunerToggle.classList.add("playing");
    showTunerIdle();
    tunerLoop();
  } catch (e) {
    tunerActive = false;
    el.tunerToggle.textContent = "Start Tuner";
    el.tunerNote.textContent = "–";
    const detail = e && e.name ? e.name + (e.message ? " — " + e.message : "") : "unknown error";
    el.tunerFreq.innerHTML =
      '<span class="vc-unsupported">Mic blocked: ' + detail + "</span>";
  }
}

function stopTuner() {
  tunerActive = false;
  if (tunerRAF) cancelAnimationFrame(tunerRAF);
  tunerRAF = null;
  if (tunerStream) {
    tunerStream.getTracks().forEach((t) => t.stop());
    tunerStream = null;
  }
  tunerAnalyser = null;
  el.tunerToggle.textContent = "Start Tuner";
  el.tunerToggle.classList.remove("playing");
}

function toggleTuner() {
  tunerActive ? stopTuner() : startTuner();
}

/* =========================================================================
 * View switching (Metronome ↔ Tuner)
 * ========================================================================= */
function showView(name) {
  const toTuner = name === "tuner";
  el.metronomeView.hidden = toTuner;
  el.tunerView.hidden = !toTuner;
  el.tabMetronome.classList.toggle("active", !toTuner);
  el.tabTuner.classList.toggle("active", toTuner);
  if (toTuner) {
    if (state.isPlaying) stop();
    stopListening(); // free the mic; voice isn't used in the tuner
    startTuner();
  } else {
    stopTuner();
    stopTone();
    startListening(); // resume hands-free control on the metronome
  }
}

el.tabMetronome.addEventListener("click", () => showView("metronome"));
el.tabTuner.addEventListener("click", () => showView("tuner"));
el.tunerToggle.addEventListener("click", toggleTuner);
el.tunerInstrument.addEventListener("change", () => {
  setInstrument(el.tunerInstrument.value);
  if (tunerActive) showTunerIdle();
});
setInstrument(el.tunerInstrument.value); // initialize (chromatic by default)
el.tunerToneBtn.addEventListener("click", toggleTone);
el.tunerRef.addEventListener("change", () => {
  tunerRefA = Number(el.tunerRef.value) || 441;
  if (toneOsc) toneOsc.frequency.setValueAtTime(tunerRefA, audioCtx.currentTime);
});
tunerRefA = Number(el.tunerRef.value) || 441; // initialize (441 default)

/* =========================================================================
 * Practice presets — save the current tempo/time-signature/subdivision under a
 * name and reload it in one tap. Stored locally (no account, works offline).
 * ========================================================================= */
const PRESETS_KEY = "metro_presets_v1";
function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY)) || []; } catch (_) { return []; }
}
function persistPresets(list) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); } catch (_) {}
}
function applyPreset(p) {
  setBpm(p.bpm);
  setTimeSignature(p.numerator, p.denominator);
  setSubdiv(p.subdiv || 1);
}
function addPreset() {
  const label = state.bpm + " · " + state.numerator + "/" + state.denominator;
  let name;
  try { name = window.prompt("Name this preset (e.g. a piece or scale)", label); }
  catch (_) { name = label; }
  if (name === null) return; // cancelled
  name = (name || label).trim().slice(0, 40) || label;
  const list = loadPresets();
  list.push({
    name,
    bpm: state.bpm,
    numerator: state.numerator,
    denominator: state.denominator,
    subdiv: state.subdiv,
  });
  persistPresets(list);
  renderPresets();
}
function deletePreset(i) {
  const list = loadPresets();
  list.splice(i, 1);
  persistPresets(list);
  renderPresets();
}
function renderPresets() {
  const list = loadPresets();
  el.presetList.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("span");
    empty.className = "presets-empty";
    empty.textContent = "Save the current tempo & time signature to reuse it.";
    el.presetList.appendChild(empty);
    return;
  }
  list.forEach((p, i) => {
    const chip = document.createElement("span");
    chip.className = "preset-chip";
    const load = document.createElement("button");
    load.className = "preset-load";
    load.textContent = p.name;
    load.title = p.bpm + " BPM · " + p.numerator + "/" + p.denominator;
    load.addEventListener("click", () => applyPreset(p));
    const del = document.createElement("button");
    del.className = "preset-del";
    del.textContent = "×";
    del.setAttribute("aria-label", "Delete preset");
    del.addEventListener("click", (e) => { e.stopPropagation(); deletePreset(i); });
    chip.appendChild(load);
    chip.appendChild(del);
    el.presetList.appendChild(chip);
  });
}
el.presetSave.addEventListener("click", addPreset);
renderPresets();

// --- Init ---
buildBeats();
setBpm(120);
setTimeSignature(4, 4);
setSubdiv(1);
setVolume(state.volume);
loadVoices();
if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = loadVoices;
populateRecogLangs();
initRecognition();
// Boot-state banner so the native/plugin wiring is visible on-device before
// any command is spoken (harmless one-liner in a plain browser too).
resolveNativeSR();
diag(
  "platform=" + PLATFORM +
  " · native=" + IS_NATIVE +
  " · SR=" + !!NativeSR +
  (NativeSR ? " (" + nativeResolveNote + ")" : " · why: " + nativeResolveNote)
);
startListening();

// The Capacitor plugin bridge can attach a beat after our scripts run. If we're
// native but the plugin wasn't there yet, keep retrying briefly and switch over
// to native recognition the moment it appears.
if (IS_NATIVE && !NativeSR) {
  let tries = 0;
  const retry = setInterval(() => {
    tries++;
    if (resolveNativeSR()) {
      clearInterval(retry);
      if (recognition) {
        try { recognition.stop(); } catch (_) {}
      }
      listening = false;
      diag("Native plugin ready (" + nativeResolveNote + ") — switching to native");
      startListening();
    } else if (tries >= 25) {
      clearInterval(retry);
    }
  }, 300);
}

function unlockAudioOnce() {
  ensureAudio();
  // The auto-start on load is flaky on mobile until there's a real user
  // gesture (you'd otherwise have to toggle the mic once to get it going).
  // On the first interaction, give recognition a clean, gesture-backed restart.
  if (recognition && !tunerActive) {
    listening = true;
    setMicUI(true);
    // A single clean restart behind a real gesture — recreate the session if
    // it's running (the load-time one is often dead), else just start it.
    if (recogRunning) {
      try {
        recognition.stop(); // onend restarts it exactly once
      } catch (_) {}
    } else {
      try {
        recognition.start();
      } catch (_) {}
    }
  }
  window.removeEventListener("pointerdown", unlockAudioOnce, true);
  window.removeEventListener("keydown", unlockAudioOnce, true);
}
// Capture phase, so it runs before any inner handler that calls
// stopPropagation (e.g. tapping the wheel's center start/stop button).
window.addEventListener("pointerdown", unlockAudioOnce, true);
window.addEventListener("keydown", unlockAudioOnce, true);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

let loadedBuild = null;
async function checkForUpdate() {
  try {
    const res = await fetch("version.json?_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return;
    const { build } = await res.json();
    if (!build) return;
    if (loadedBuild === null) {
      loadedBuild = build;
      return;
    }
    if (build !== loadedBuild) {
      loadedBuild = build;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      } catch (_) {}
      window.location.reload();
    }
  } catch (_) {}
}
checkForUpdate();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForUpdate();
});
setInterval(checkForUpdate, 30000);
