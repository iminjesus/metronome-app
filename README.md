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
