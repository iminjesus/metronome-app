# Metronome

A simple, accurate metronome that runs entirely in the browser — no build step, no dependencies.

## Features

- **Accurate timing** using the Web Audio API with a look-ahead scheduler (clicks stay on the audio clock, not the jittery JS timer)
- **Tempo control** from 30–240 BPM via slider or ±1 / ±5 nudge buttons
- **Tap tempo** — tap the button (or press `T`) to set the tempo by feel
- **Time signatures** — 1 to 8 beats per bar, with an accented downbeat
- **Visual beat indicator** synced to the audio
- **Keyboard shortcuts** — `Space` to start/stop, `T` to tap
- **Tempo markings** (Largo, Andante, Allegro, …) shown for the current BPM
- **Speed Trainer** — ramps the tempo automatically (e.g. 50 → 150 BPM, +10 every 30s) and announces each change out loud; the spoken voice/language is chosen from any speech-synthesis voice installed in the browser
- **Voice Control** — drive the metronome hands-free by speaking, in many languages. Manual controls keep working at the same time, so you can mix voice and touch freely.

## Voice commands

Open the **🎤 Voice Control** panel, pick a recognition language, and press
**Start Listening**. Commands are matched loosely, in the selected language:

| Say | Does |
|-----|------|
| "start" / "시작" | Play |
| "stop" / "정지" | Stop |
| "faster" / "빠르게" | +5 BPM |
| "slower" / "느리게" | −5 BPM |
| a number, e.g. "120" | Set the tempo |
| "tap" | Tap tempo |
| "trainer" | Start / stop the Speed Trainer |

> Speech recognition uses the Web Speech API, which currently works in
> **Chrome and Edge** (desktop). The first time, the browser asks for
> microphone permission. Spoken numbers are recognized as digits; number
> *words* in some languages may not parse — say or set them manually if so.

## Run it

It's a static site — just open `index.html` in a browser.

Or serve it locally:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup and layout |
| `style.css` | Styling (dark theme) |
| `app.js` | Metronome engine, scheduler, and UI logic |

## How the timing works

Naively firing a click on `setInterval` drifts audibly because JS timers aren't
precise. Instead, a timer wakes up every 25 ms and schedules any clicks that
fall within the next 100 ms directly on the Web Audio clock via
`oscillator.start(time)`. The audio hardware then plays each click at exactly
the right moment. The on-screen beat dots are flipped in a
`requestAnimationFrame` loop that watches the same audio clock, so the visuals
stay in sync with what you hear.
