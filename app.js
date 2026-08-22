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
  isPlaying: false,
  currentBeat: 0,
  currentSub: 0,
  nextNoteTime: 0,
};

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.1;

let audioCtx = null;
let schedulerTimer = null;
const notesInQueue = [];

// --- DOM ---
const el = {
  bpmValue: document.getElementById("bpmValue"),
  tempoName: document.getElementById("tempoName"),
  beats: document.getElementById("beats"),
  beatsPerBar: document.getElementById("beatsPerBar"),
  startBtn: document.getElementById("startBtn"),
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
  tunerNote: document.getElementById("tunerNote"),
  tunerFreq: document.getElementById("tunerFreq"),
  tunerCents: document.getElementById("tunerCents"),
  tunerNeedle: document.getElementById("tunerNeedle"),
  tunerToggle: document.getElementById("tunerToggle"),
  voicePanel: document.getElementById("voicePanel"),
  voiceToggle: document.getElementById("voiceToggle"),
  micBtn: document.getElementById("micBtn"),
  vcLang: document.getElementById("vcLang"),
  vcHeard: document.getElementById("vcHeard"),
  vcCmd: document.getElementById("vcCmd"),
};

// --- Audio ---
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
  gain.connect(audioCtx.destination);
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
  el.startBtn.textContent = "Stop";
  el.startBtn.classList.add("playing");
  el.dialCenter.classList.add("playing");
}
function stop() {
  state.isPlaying = false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  notesInQueue.length = 0;
  for (const dot of el.beats.children) dot.classList.remove("active", "accent");
  el.startBtn.textContent = "Start";
  el.startBtn.classList.remove("playing");
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

// --- Tap tempo ---
let tapTimes = [];
function tap() {
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes.shift();
  if (tapTimes.length >= 2) {
    let total = 0;
    for (let i = 1; i < tapTimes.length; i++) total += tapTimes[i] - tapTimes[i - 1];
    setBpm(60000 / (total / (tapTimes.length - 1)));
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
  if (!recognition) return;
  ensureAudio();
  recognition.lang = el.vcLang.value;
  listening = true;
  try {
    recognition.start();
  } catch (_) {}
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
el.startBtn.addEventListener("click", toggle);
el.tapBtn.addEventListener("click", tap);
el.micBtn.addEventListener("click", toggleListening);
el.vcLang.addEventListener("change", () => {
  if (listening && recognition) recognition.stop();
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

function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // too quiet

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
  if (T0 <= 0) return -1;

  const x1 = c[T0 - 1] || 0;
  const x2 = c[T0];
  const x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2;
  const bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);

  const freq = sampleRate / T0;
  return freq > 25 && freq < 4500 ? freq : -1;
}

function updateTunerDisplay(freq) {
  const noteNum = 12 * Math.log2(freq / 440) + 69;
  const rounded = Math.round(noteNum);
  const cents = Math.round((noteNum - rounded) * 100);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  const inTune = Math.abs(cents) <= 5;

  el.tunerNote.textContent = name + octave;
  el.tunerFreq.textContent = freq.toFixed(1) + " Hz";
  el.tunerCents.textContent = (cents > 0 ? "+" : "") + cents + " ¢";
  el.tunerNeedle.style.left = 50 + Math.max(-50, Math.min(50, cents)) + "%";
  el.tunerNote.classList.toggle("in-tune", inTune);
  el.tunerNeedle.classList.toggle("in-tune", inTune);
}

function tunerLoop() {
  if (!tunerActive || !tunerAnalyser) return;
  tunerAnalyser.getFloatTimeDomainData(tunerBuf);
  const freq = autoCorrelate(tunerBuf, audioCtx.sampleRate);
  if (freq > 0) {
    updateTunerDisplay(freq);
  } else {
    el.tunerFreq.textContent = "Listening…";
    el.tunerNote.classList.remove("in-tune");
  }
  tunerRAF = requestAnimationFrame(tunerLoop);
}

async function startTuner() {
  try {
    ensureAudio();
    tunerStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = audioCtx.createMediaStreamSource(tunerStream);
    tunerAnalyser = audioCtx.createAnalyser();
    tunerAnalyser.fftSize = 2048;
    src.connect(tunerAnalyser);
    tunerBuf = new Float32Array(tunerAnalyser.fftSize);
    tunerActive = true;
    el.tunerToggle.textContent = "Stop Tuner";
    el.tunerToggle.classList.add("playing");
    el.tunerFreq.textContent = "Listening…";
    tunerLoop();
  } catch (_) {
    tunerActive = false;
    el.tunerToggle.textContent = "Start Tuner";
    el.tunerNote.textContent = "–";
    el.tunerFreq.innerHTML =
      '<span class="vc-unsupported">Microphone access needed — tap Start.</span>';
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
    startListening(); // resume hands-free control on the metronome
  }
}

el.tabMetronome.addEventListener("click", () => showView("metronome"));
el.tabTuner.addEventListener("click", () => showView("tuner"));
el.tunerToggle.addEventListener("click", toggleTuner);

// --- Init ---
buildBeats();
setBpm(120);
setTimeSignature(4, 4);
setSubdiv(1);
loadVoices();
if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = loadVoices;
populateRecogLangs();
initRecognition();
startListening();

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
