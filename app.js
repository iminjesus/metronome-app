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
  return false;
}
function parseTrainerConfig(text) {
  const cfg = { start: 50, target: 150, step: 10, interval: 30 };
  let m;
  if ((m = text.match(/(?:every|각|매|마다|간격)\s*(\d{1,3})/))) cfg.interval = clampRange(+m[1], 2, 600);
  if ((m = text.match(/(\d{1,3})\s*(?:초|secs?|seconds?)/))) cfg.interval = clampRange(+m[1], 2, 600);
  if ((m = text.match(/(?:by|steps?(?:\s+of)?|스텝|단계)\s*(\d{1,3})/))) cfg.step = clampRange(+m[1], 1, 60);
  if ((m = text.match(/(\d{1,3})\s*씩/))) cfg.step = clampRange(+m[1], 1, 60);
  let startN = null;
  let targetN = null;
  if ((m = text.match(/(\d{1,3})\s*(?:부터|에서)/))) startN = +m[1];
  else if ((m = text.match(/(?:from|starting(?:\s+at)?)\s+(\d{1,3})/))) startN = +m[1];
  if ((m = text.match(/(\d{1,3})\s*까지/))) targetN = +m[1];
  else if ((m = text.match(/(?:up to|\bto\b|\buntil\b|목표)\s*(\d{1,3})/))) targetN = +m[1];
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
};
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

let recognition = null;
let listening = false;
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
  el.vcHeard.textContent = "“" + raw.trim() + "”";

  if (matchAny(text, KEYWORDS.reset)) {
    stopTrainer();
    setBpm(120);
    setTimeSignature(4, 4);
    setSubdiv(1);
    flashCmd("Reset");
    return;
  }
  if (isRampPhrase(text)) {
    const hasNums = /\d{2,3}/.test(text);
    if (!hasNums && trainer.active) {
      stopTrainer();
      flashCmd("Ramp ■");
      return;
    }
    const cfg = parseTrainerConfig(text);
    if (trainer.active) stopTrainer();
    startTrainer(cfg);
    flashCmd(`Ramp ▶ ${cfg.start}→${cfg.target}`);
    return;
  }
  if (matchAny(text, KEYWORDS.subdiv)) {
    const m = text.match(/([1-4])/);
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
  recognition.onend = () => {
    if (listening) {
      try {
        recognition.start();
      } catch (_) {}
    }
  };
}
function setMicUI(on) {
  el.micBtn.classList.toggle("listening", on);
  el.micBtn.textContent = on ? "🛑 Stop Listening" : "🎤 Start Listening";
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
  window.removeEventListener("pointerdown", unlockAudioOnce);
  window.removeEventListener("keydown", unlockAudioOnce);
}
window.addEventListener("pointerdown", unlockAudioOnce);
window.addEventListener("keydown", unlockAudioOnce);

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
