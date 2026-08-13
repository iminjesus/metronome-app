/**
 * Metronome — accurate timing via the Web Audio API.
 *
 * Uses a look-ahead scheduler (Chris Wilson's "A Tale of Two Clocks" pattern):
 * a setInterval fires frequently but only schedules audio events that fall
 * inside a short look-ahead window, so click timing rides on the sample-accurate
 * audio clock instead of the jittery JS timer.
 */

// --- Tempo naming (traditional Italian markings) ---
const TEMPO_NAMES = [
  [40, "Grave"],
  [60, "Largo"],
  [66, "Larghetto"],
  [76, "Adagio"],
  [108, "Andante"],
  [120, "Moderato"],
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
}

function toggle() {
  state.isPlaying ? stop() : start();
}

// --- BPM handling ---
function setBpm(bpm) {
  state.bpm = Math.max(30, Math.min(240, Math.round(bpm)));
  el.bpmValue.textContent = state.bpm;
  el.tempoName.textContent = tempoName(state.bpm);
  el.slider.value = state.bpm;
  const pct = ((state.bpm - 30) / (240 - 30)) * 100;
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

// --- Events ---
el.slider.addEventListener("input", (e) => setBpm(Number(e.target.value)));

document.querySelectorAll(".nudge-btn").forEach((btn) => {
  btn.addEventListener("click", () =>
    setBpm(state.bpm + Number(btn.dataset.delta))
  );
});

el.beatsPerBar.addEventListener("change", (e) => {
  state.beatsPerBar = Number(e.target.value);
  state.currentBeat = 0;
  buildBeatDots();
});

el.startBtn.addEventListener("click", toggle);
el.tapBtn.addEventListener("click", tap);

document.addEventListener("keydown", (e) => {
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
