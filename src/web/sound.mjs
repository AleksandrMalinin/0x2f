// The slash — 0x2F's one sound.
//
// A single synthesized gesture, generated with the Web Audio API: no media
// assets, no library, a handful of oscillator/envelope parameters. The sound
// is the identity, not a notification jingle:
//
//   READY       one stroke  — a dry descending glide, like a relay engaging
//   NEEDS YOU   two strokes — the SAME object struck again, its second stroke
//               aborted mid-descent: interrupted, unresolved
//
// Internal design detail (not branding): the stroke descends 940 -> 705 Hz,
// which is 47*20 -> 47*15 — 47 is 0x2F. If it ever sounds better otherwise,
// change the numbers; the connection is private.
//
// Silence is the default: this module never forces audio. If the AudioContext
// cannot be created or is not running (autoplay policy before any user
// gesture), a gesture is skipped silently — sound is never required to use
// 0x2F. Call `unlock()` from the first user interaction so later
// background-tab signals can sound.

export function createSlashPlayer() {
  let ctx = null;

  function context() {
    if (ctx) return ctx;
    // No window (a worker, a test runner) means no audio — a silent no-op.
    const w = typeof window === "undefined" ? null : window;
    const AC = w?.AudioContext || w?.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  // Autoplay policy: a context starts suspended until the page has user
  // activation. Call from the first pointer/key interaction; afterwards the
  // browser allows audio even from a backgrounded tab.
  function unlock() {
    const ac = context();
    if (!ac || ac.state === "running") return;
    if (ac.state === "suspended") ac.resume().catch(() => {});
  }

  // One descending stroke: triangle glide + a tiny high-passed click for the
  // mechanical transient. Scheduled only when the context is actually
  // running; a suspended context would play everything late on resume.
  function stroke({ at, f0, f1, dur, peak, click = true }) {
    const ac = context();
    if (!ac || ac.state !== "running") return;
    const t0 = ac.currentTime + at;

    const osc = ac.createOscillator();
    const tone = ac.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    tone.gain.setValueAtTime(0.0001, t0);
    tone.gain.exponentialRampToValueAtTime(peak, t0 + 0.002);
    tone.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(tone).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);

    if (!click) return;
    const noiseDur = 0.008;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * noiseDur), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const hp = ac.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3000;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(peak * 0.3, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + noiseDur);
    src.connect(hp).connect(gain).connect(ac.destination);
    src.start(t0);
  }

  return {
    unlock,
    // READY — one complete stroke.
    ready() {
      stroke({ at: 0, f0: 940, f1: 705, dur: 0.07, peak: 0.18 });
    },
    // NEEDS YOU — the same stroke, then the same object interrupted: a second,
    // shorter stroke whose descent stops early.
    needsYou() {
      stroke({ at: 0, f0: 940, f1: 705, dur: 0.07, peak: 0.18 });
      stroke({ at: 0.15, f0: 940, f1: 850, dur: 0.045, peak: 0.13, click: false });
    },
    // Test/debug seam: whether audio can currently play.
    running() {
      return ctx !== null && ctx.state === "running";
    }
  };
}
