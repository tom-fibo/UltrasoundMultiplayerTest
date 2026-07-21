// Pure encode/decode logic for sending a normalized (x, y) coordinate over
// near-ultrasonic audio using multi-frequency shift keying (MFSK).
//
// No Web Audio / DOM APIs are used in this file on purpose: everything here
// is a plain function of numbers/arrays so it can be unit tested without a
// microphone, speaker, or browser at all.
//
// FRAME FORMAT (7 symbols, each a single tone or silence):
//   [ SOF ] [ xHi ] [ xLo ] [ yHi ] [ yLo ] [ checksum ] [ EOF ]
// x and y are each quantized to 8 bits (0-255) and split into a high and
// low nibble (4 bits, 0-15). Each nibble is transmitted as one of 16 tones.
// checksum = XOR of the 4 payload nibbles, so single-nibble corruption
// (a missed/misread tone) is detected and the frame is dropped.

export const CONFIG = Object.freeze({
  toneBaseHz: 18000, // frequency of nibble 0x0
  toneSpacingHz: 100, // spacing between adjacent nibble tones
  numTones: 16, // one tone per nibble value 0x0-0xF
  sofHz: 19700, // start-of-frame marker
  eofHz: 19900, // end-of-frame marker
  bitsPerAxis: 8, // quantization resolution per axis
  symbolMs: 120, // duration a tone is held on
  gapMs: 40, // silence gap between symbols (aids receiver framing)
  toneToleranceHz: 45, // how close a detected frequency must be to a tone to count
});

/** Clamp a value into [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Quantize a normalized [0,1] float to an unsigned integer with `bits` bits. */
export function quantize(value, bits = CONFIG.bitsPerAxis) {
  const maxInt = (1 << bits) - 1;
  const v = clamp(value, 0, 1);
  return Math.round(v * maxInt);
}

/** Inverse of quantize(): integer with `bits` bits back to a [0,1] float. */
export function dequantize(intValue, bits = CONFIG.bitsPerAxis) {
  const maxInt = (1 << bits) - 1;
  return clamp(intValue, 0, maxInt) / maxInt;
}

/** Frequency in Hz used to transmit a 4-bit nibble (0-15). */
export function freqForNibble(nibble) {
  if (nibble < 0 || nibble > 15 || !Number.isInteger(nibble)) {
    throw new RangeError(`nibble out of range: ${nibble}`);
  }
  return CONFIG.toneBaseHz + nibble * CONFIG.toneSpacingHz;
}

/**
 * Map a detected frequency back to a tone symbol.
 * Returns { type: 'nibble', value: 0-15 } | { type: 'sof' } | { type: 'eof' } | null
 * (null means the frequency doesn't match any known tone within tolerance).
 */
export function symbolForFreq(freq, tolerance = CONFIG.toneToleranceHz) {
  if (freq == null) return null;
  if (Math.abs(freq - CONFIG.sofHz) <= tolerance) return { type: "sof" };
  if (Math.abs(freq - CONFIG.eofHz) <= tolerance) return { type: "eof" };
  for (let n = 0; n < CONFIG.numTones; n++) {
    if (Math.abs(freq - freqForNibble(n)) <= tolerance) {
      return { type: "nibble", value: n };
    }
  }
  return null;
}

/** Split an 8-bit int into [highNibble, lowNibble]. */
function toNibbles(byteValue) {
  return [(byteValue >> 4) & 0xf, byteValue & 0xf];
}

/** Combine [highNibble, lowNibble] back into an 8-bit int. */
function fromNibbles(hi, lo) {
  return ((hi & 0xf) << 4) | (lo & 0xf);
}

/** XOR checksum (0-15) over an array of nibbles. */
export function checksumNibbles(nibbles) {
  return nibbles.reduce((acc, n) => acc ^ (n & 0xf), 0) & 0xf;
}

/**
 * Encode a normalized (x, y) coordinate into the ordered list of payload
 * nibbles plus checksum: [xHi, xLo, yHi, yLo, checksum].
 */
export function encodeCoordinate(x, y, bits = CONFIG.bitsPerAxis) {
  const xInt = quantize(x, bits);
  const yInt = quantize(y, bits);
  const [xHi, xLo] = toNibbles(xInt);
  const [yHi, yLo] = toNibbles(yInt);
  const payload = [xHi, xLo, yHi, yLo];
  return { payload, checksum: checksumNibbles(payload) };
}

/**
 * Decode 4 payload nibbles (+ expected checksum) back into {x, y}.
 * Returns null if the checksum doesn't match (treated as a corrupted frame).
 */
export function decodeCoordinate(payload, checksum, bits = CONFIG.bitsPerAxis) {
  if (payload.length !== 4) return null;
  if (checksumNibbles(payload) !== (checksum & 0xf)) return null;
  const [xHi, xLo, yHi, yLo] = payload;
  const x = dequantize(fromNibbles(xHi, xLo), bits);
  const y = dequantize(fromNibbles(yHi, yLo), bits);
  return { x, y };
}

/**
 * Build the full symbol timeline to transmit for a coordinate: an ordered
 * array of { freqHz: number|null, durationMs: number }. freqHz === null
 * means silence (the inter-symbol gap).
 */
export function buildFrameSymbols(x, y, config = CONFIG) {
  const { payload, checksum } = encodeCoordinate(x, y, config.bitsPerAxis);
  const tones = [config.sofHz, ...payload.map(freqForNibble), freqForNibble(checksum), config.eofHz];

  const symbols = [];
  tones.forEach((freqHz, i) => {
    if (i > 0) symbols.push({ freqHz: null, durationMs: config.gapMs });
    symbols.push({ freqHz, durationMs: config.symbolMs });
  });
  return symbols;
}

/**
 * Total wall-clock duration (ms) of a frame built with the given config,
 * useful for estimating achievable bandwidth.
 */
export function frameDurationMs(config = CONFIG) {
  const numTones = 7; // SOF + 4 payload nibbles + checksum + EOF
  return numTones * config.symbolMs + (numTones - 1) * config.gapMs;
}

/**
 * Parse an ordered sequence of *confirmed* (debounced) tone symbols - as
 * produced by the receiver's tone detector, with silence/nulls already
 * filtered out - into a decoded coordinate.
 *
 * `symbols` is an array of results from symbolForFreq (sof/eof/nibble
 * objects), in the order they were detected. Extra noise before an SOF or
 * after an EOF is ignored; only the first complete SOF..EOF frame found is
 * decoded.
 *
 * Returns { x, y } on success, or { error: string } on failure.
 */
export function parseSymbolSequence(symbols) {
  const sofIndex = symbols.findIndex((s) => s && s.type === "sof");
  if (sofIndex === -1) return { error: "no-sof" };

  const rest = symbols.slice(sofIndex + 1);
  const eofIndex = rest.findIndex((s) => s && s.type === "eof");
  if (eofIndex === -1) return { error: "no-eof" };

  const body = rest.slice(0, eofIndex);
  if (body.length !== 5) return { error: `bad-length:${body.length}` };
  if (!body.every((s) => s && s.type === "nibble")) return { error: "non-nibble-in-body" };

  const nibbleValues = body.map((s) => s.value);
  const payload = nibbleValues.slice(0, 4);
  const checksum = nibbleValues[4];

  const decoded = decodeCoordinate(payload, checksum);
  if (!decoded) return { error: "checksum-mismatch" };
  return decoded;
}
