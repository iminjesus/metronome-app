# Metronome

A simple, accurate metronome that runs entirely in the browser — no build step, no dependencies.

## Features

- **iPod-style click wheel** — drag around the wheel to set the tempo, with a center start/stop button and a position indicator
- **Accurate timing** using the Web Audio API with a look-ahead scheduler (clicks stay on the audio clock, not the jittery JS timer)
- **Tempo control** from 30–240 BPM via the wheel or ±1 / ±5 buttons
- **Time signature & subdivision** — beats per bar (incl. voice signatures like 6/8) and 1–4 subdivisions per beat (voice)
- **Tap tempo** — tap the button (or press `T`) to set the tempo by feel
- **Time signatures** — 1 to 8 beats per bar, with an accented downbeat
- **Visual beat indicator** synced to the audio
- **Keyboard shortcuts** — `Space` to start/stop, `T` to tap
- **Tempo markings** (Largo, Andante, Allegro, …) shown for the current BPM
- **Voice-started speed ramp** — say e.g. "trainer 50 to 150 by 10 every 30" and the tempo ramps up automatically, announcing each change out loud (the spoken language follows your recognition language); a compact status line shows progress
- **Voice Control** — drive the metronome hands-free by speaking, in many languages. Manual controls keep working at the same time, so you can mix voice and touch freely.

## Voice commands

The app **listens automatically** as soon as it loads (the browser asks for
microphone permission the first time), so you can control everything hands-free
while playing an instrument. Manual controls keep working at the same time.
Pick your language in the **🎤 Voice Control** panel. Commands are matched
loosely, in the selected language:

| Say | Does |
|-----|------|
| "go" / "start" / "시작" | Play |
| "stop" / "정지" | Stop |
| "faster" / "빠르게" | +5 BPM |
| "slower" / "느리게" | −5 BPM |
| a number, e.g. "120" | Set the tempo |
| "presto" / "andante" / "allegro" / "안단테" … | Set the tempo by its Italian marking |
| "three four" / "6/8" / "8분의 6박자" / "waltz" | Change the time signature (numerator/denominator) |
| "subdivision 2" / "세분박 3" | Set the beat subdivision (1–4) |
| "tap" | Tap tempo |
| "50 to 150" / "from 50 up to 150 by 10 every 30" / "50부터 시작해서 150까지 10씩 30초마다" | Start a speed ramp — just name a start and target however you like (extra parts optional; "trainer" alone = 50 → 150, +10 / 30s). "stop" ends it. |
| while ramping: "every 7 seconds" / "매 7초만" / "8씩" / "200까지" | Adjust one part of the running ramp in place, keeping the rest |
| "reset" / "리셋" | Back to 120 BPM, 4 beats |

> **Browser:** speech recognition uses the Web Speech API, which currently works
> in **Chrome and Edge** (desktop). For reliable microphone access, serve the
> page over `http://localhost` (see below) rather than opening the file
> directly — some browsers block the mic on `file://` pages.
>
> Spoken numbers are recognized as digits; number *words* in some languages may
> not parse — say or set them manually if so.

## Run it

It's a static site — just open `index.html` in a browser.

Or serve it locally:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Install as an app (PWA)

The app is a Progressive Web App, so it can be installed on a phone or desktop
and run full-screen like a native app — no app store needed. It must be served
over **https** (e.g. GitHub Pages) or `http://localhost` for install + offline
to work.

- **Android (Chrome):** open the site → menu → **Add to Home screen / Install app**
- **iOS (Safari):** open the site → Share → **Add to Home Screen**
- **Desktop (Chrome/Edge):** an **install** icon appears in the address bar

> Note: hands-free voice control uses the Web Speech API, which works in Chrome
> (desktop/Android) but **not on iOS**. On iOS the metronome, trainer, and
> spoken tempo announcements still work; only voice *commands* are unavailable.

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
