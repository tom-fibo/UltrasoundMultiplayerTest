// Listens to the microphone, continuously runs an FFT, and decodes any
// complete SOF..EOF tone frame it hears back into a coordinate using
// codec.js. All the "what tone is this" and "what frame does this sequence
// spell" logic lives in codec.js (and is unit tested there); this file is
// just the plumbing that feeds live microphone data through it.

import { CONFIG, symbolForFreq, parseSymbolSequence } from "./codec.js";

const POLL_MS = 25; // how often we sample the FFT
const DEBOUNCE_MS = 45; // a raw tone must be stable this long to "confirm"
const SILENCE_DB = -65; // peak magnitude below this counts as silence
const FFT_SIZE = 8192;
const MAX_BUFFERED_SYMBOLS = 12; // desync guard

function symbolsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.value === b.value;
}

export class Receiver {
  /**
   * @param {object} opts
   * @param {(coord: {x:number,y:number}) => void} opts.onDecode
   * @param {(info: object) => void} [opts.onDebug] - fired ~every poll with { freqHz, dB, symbol }
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor({ onDecode, onDebug, onError, audioContext } = {}) {
    this.onDecode = onDecode || (() => {});
    this.onDebug = onDebug || (() => {});
    this.onError = onError || (() => {});
    this.audioContext = audioContext || null;
    this.stream = null;
    this.intervalId = null;

    this._buffer = [];
    this._lastCandidate = null;
    this._candidateSince = 0;
    this._lastConfirmed = null;
  }

  get isListening() {
    return this.intervalId != null;
  }

  async start() {
    if (this.isListening) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    this.audioContext = this.audioContext || new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioContext.state === "suspended") await this.audioContext.resume();

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.2;
    this.sourceNode.connect(this.analyser);

    this._freqData = new Float32Array(this.analyser.frequencyBinCount);
    this._buffer = [];
    this._lastCandidate = null;
    this._lastConfirmed = null;

    this.intervalId = setInterval(() => this._tick(), POLL_MS);
  }

  stop() {
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.analyser = null;
  }

  _tick() {
    try {
      this._pollOnce();
    } catch (err) {
      this.onError(err);
    }
  }

  _pollOnce() {
    const analyser = this.analyser;
    analyser.getFloatFrequencyData(this._freqData);

    const sampleRate = this.audioContext.sampleRate;
    const binHz = sampleRate / analyser.fftSize;
    const bandLoHz = CONFIG.toneBaseHz - CONFIG.toneToleranceHz;
    const bandHiHz = CONFIG.eofHz + CONFIG.toneToleranceHz;
    const loBin = Math.max(0, Math.floor(bandLoHz / binHz));
    const hiBin = Math.min(this._freqData.length - 1, Math.ceil(bandHiHz / binHz));

    let peakBin = -1;
    let peakDb = -Infinity;
    for (let b = loBin; b <= hiBin; b++) {
      const db = this._freqData[b];
      if (db > peakDb) {
        peakDb = db;
        peakBin = b;
      }
    }

    const detectedFreq = peakDb > SILENCE_DB ? peakBin * binHz : null;
    const rawSymbol = symbolForFreq(detectedFreq);

    this.onDebug({ freqHz: detectedFreq, dB: peakDb, symbol: rawSymbol });

    this._debounceAndFeed(rawSymbol);
  }

  _debounceAndFeed(rawSymbol) {
    const now = performance.now();

    if (!symbolsEqual(rawSymbol, this._lastCandidate)) {
      this._lastCandidate = rawSymbol;
      this._candidateSince = now;
      return;
    }

    const stableFor = now - this._candidateSince;
    if (stableFor < DEBOUNCE_MS) return;

    if (symbolsEqual(rawSymbol, this._lastConfirmed)) return; // no change
    this._lastConfirmed = rawSymbol;

    if (rawSymbol == null) return; // confirmed silence; nothing to buffer

    this._buffer.push(rawSymbol);
    if (this._buffer.length > MAX_BUFFERED_SYMBOLS) {
      this._buffer = [];
      return;
    }

    this._tryParse();
  }

  _tryParse() {
    const result = parseSymbolSequence(this._buffer);
    if (result.error === "no-eof") return; // keep accumulating
    if (result.error === "no-sof") {
      this._buffer = [];
      return;
    }
    if (result.error) {
      // A complete SOF..EOF span was found but was invalid (checksum
      // mismatch, wrong length, stray tone). Drop it and resync on the
      // next SOF rather than getting stuck.
      this._buffer = [];
      return;
    }
    this._buffer = [];
    this.onDecode(result);
  }
}
