// Plays a coordinate as a sequence of near-ultrasonic tones using the Web
// Audio API. Depends on codec.js for the symbol timeline; this file only
// deals with actually driving an OscillatorNode/GainNode.

import { buildFrameSymbols, frameDurationMs, CONFIG } from "./codec.js";

const RAMP_S = 0.008; // gain ramp time to avoid audible clicks at tone edges

export class Transmitter {
  constructor({ audioContext } = {}) {
    this.audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  }

  /** Resume the AudioContext (must be called from a user gesture on some browsers). */
  async ensureRunning() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  /**
   * Play the tone sequence encoding (x, y). Returns the total duration (ms)
   * of the transmission so callers can estimate achieved bandwidth.
   */
  async send(x, y, { volume = 0.6 } = {}) {
    await this.ensureRunning();

    const ctx = this.audioContext;
    const symbols = buildFrameSymbols(x, y);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    osc.connect(gain).connect(ctx.destination);

    let t = ctx.currentTime + 0.02; // small lead-in so scheduling isn't racing "now"
    const startTime = t;

    for (const symbol of symbols) {
      const durationS = symbol.durationMs / 1000;
      if (symbol.freqHz != null) {
        osc.frequency.setValueAtTime(symbol.freqHz, t);
        gain.gain.linearRampToValueAtTime(volume, t + RAMP_S);
        gain.gain.setValueAtTime(volume, t + durationS - RAMP_S);
        gain.gain.linearRampToValueAtTime(0, t + durationS);
      } else {
        gain.gain.setValueAtTime(0, t);
      }
      t += durationS;
    }

    osc.start(startTime);
    osc.stop(t + 0.02);

    return new Promise((resolve) => {
      osc.onended = () => resolve(frameDurationMs());
    });
  }
}

export { CONFIG };
