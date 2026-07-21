import { test, assert, assertEqual, assertClose, assertDeepEqual } from "./tiny-test.js";
import {
  CONFIG,
  clamp,
  quantize,
  dequantize,
  freqForNibble,
  symbolForFreq,
  checksumNibbles,
  encodeCoordinate,
  decodeCoordinate,
  buildFrameSymbols,
  frameDurationMs,
  parseSymbolSequence,
} from "../js/codec.js";

// ---- clamp / quantize / dequantize -----------------------------------

test("clamp keeps in-range values unchanged", () => {
  assertEqual(clamp(0.5, 0, 1), 0.5);
});

test("clamp bounds out-of-range values", () => {
  assertEqual(clamp(-3, 0, 1), 0);
  assertEqual(clamp(3, 0, 1), 1);
});

test("quantize/dequantize round trip is within 1 quantization step", () => {
  const bits = 8;
  const step = 1 / ((1 << bits) - 1);
  for (const v of [0, 0.01, 0.25, 0.5, 0.499, 0.75, 0.999, 1]) {
    const q = quantize(v, bits);
    const back = dequantize(q, bits);
    assertClose(back, v, step / 2 + 1e-9, `value ${v} round trip via quantize`);
  }
});

test("quantize clamps out-of-range input", () => {
  assertEqual(quantize(-0.5), 0);
  assertEqual(quantize(1.5), 255);
});

test("quantize endpoints map to 0 and max int", () => {
  assertEqual(quantize(0, 8), 0);
  assertEqual(quantize(1, 8), 255);
});

// ---- frequency <-> symbol mapping --------------------------------------

test("freqForNibble produces 16 distinct frequencies in the configured band", () => {
  const freqs = new Set();
  for (let n = 0; n < 16; n++) freqs.add(freqForNibble(n));
  assertEqual(freqs.size, 16);
  for (const f of freqs) {
    assert(f >= CONFIG.toneBaseHz && f < CONFIG.sofHz, `nibble freq ${f} should be below SOF band`);
  }
});

test("freqForNibble rejects out-of-range nibbles", () => {
  let threw = false;
  try {
    freqForNibble(16);
  } catch {
    threw = true;
  }
  assert(threw, "expected freqForNibble(16) to throw");
});

test("symbolForFreq exactly identifies each nibble tone", () => {
  for (let n = 0; n < 16; n++) {
    const symbol = symbolForFreq(freqForNibble(n));
    assertDeepEqual(symbol, { type: "nibble", value: n });
  }
});

test("symbolForFreq identifies SOF and EOF markers", () => {
  assertDeepEqual(symbolForFreq(CONFIG.sofHz), { type: "sof" });
  assertDeepEqual(symbolForFreq(CONFIG.eofHz), { type: "eof" });
});

test("symbolForFreq tolerates small frequency drift within tolerance", () => {
  const nearby = freqForNibble(5) + CONFIG.toneToleranceHz * 0.5;
  assertDeepEqual(symbolForFreq(nearby), { type: "nibble", value: 5 });
});

test("symbolForFreq rejects frequencies outside tolerance and null input", () => {
  const tooFar = freqForNibble(5) + CONFIG.toneSpacingHz / 2;
  assertEqual(symbolForFreq(tooFar), null);
  assertEqual(symbolForFreq(null), null);
});

// ---- checksum -----------------------------------------------------------

test("checksumNibbles is the XOR of all nibbles", () => {
  assertEqual(checksumNibbles([0x1, 0x2, 0x3, 0x4]), 0x1 ^ 0x2 ^ 0x3 ^ 0x4);
  assertEqual(checksumNibbles([0xf, 0xf]), 0);
});

// ---- coordinate encode/decode round trip ---------------------------------

test("encodeCoordinate/decodeCoordinate round trip for a grid of points", () => {
  const points = [
    [0, 0],
    [1, 1],
    [0.5, 0.5],
    [0.1, 0.9],
    [0.999, 0.001],
    [0.3333, 0.6667],
  ];
  for (const [x, y] of points) {
    const { payload, checksum } = encodeCoordinate(x, y);
    const decoded = decodeCoordinate(payload, checksum);
    assert(decoded, `expected successful decode for (${x}, ${y})`);
    assertClose(decoded.x, x, 1 / 255 + 1e-9, "decoded x within quantization error");
    assertClose(decoded.y, y, 1 / 255 + 1e-9, "decoded y within quantization error");
  }
});

test("decodeCoordinate rejects a corrupted payload (checksum mismatch)", () => {
  const { payload, checksum } = encodeCoordinate(0.42, 0.77);
  const corrupted = [...payload];
  corrupted[1] = corrupted[1] ^ 0x1; // flip a bit in one nibble
  const decoded = decodeCoordinate(corrupted, checksum);
  assertEqual(decoded, null);
});

test("decodeCoordinate rejects wrong payload length", () => {
  assertEqual(decodeCoordinate([1, 2, 3], 0), null);
});

// ---- frame building -------------------------------------------------------

test("buildFrameSymbols starts with SOF and ends with EOF", () => {
  const symbols = buildFrameSymbols(0.2, 0.8);
  assertEqual(symbols[0].freqHz, CONFIG.sofHz);
  assertEqual(symbols[symbols.length - 1].freqHz, CONFIG.eofHz);
});

test("buildFrameSymbols alternates tone/silence and has 13 entries (7 tones + 6 gaps)", () => {
  const symbols = buildFrameSymbols(0.2, 0.8);
  assertEqual(symbols.length, 13);
  for (let i = 0; i < symbols.length; i++) {
    if (i % 2 === 1) {
      assertEqual(symbols[i].freqHz, null, `entry ${i} should be a silence gap`);
    } else {
      assert(symbols[i].freqHz != null, `entry ${i} should be a tone`);
    }
  }
});

test("buildFrameSymbols total duration matches frameDurationMs", () => {
  const symbols = buildFrameSymbols(0.2, 0.8);
  const total = symbols.reduce((sum, s) => sum + s.durationMs, 0);
  assertEqual(total, frameDurationMs());
});

// ---- full receive-side parsing --------------------------------------------

test("parseSymbolSequence decodes a clean, complete frame", () => {
  const symbols = buildFrameSymbols(0.2, 0.8)
    .filter((s) => s.freqHz != null)
    .map((s) => symbolForFreq(s.freqHz));
  const result = parseSymbolSequence(symbols);
  assert(!result.error, `expected no error, got ${result.error}`);
  assertClose(result.x, 0.2, 1 / 255 + 1e-9);
  assertClose(result.y, 0.8, 1 / 255 + 1e-9);
});

test("parseSymbolSequence ignores noise before SOF and after EOF", () => {
  const clean = buildFrameSymbols(0.6, 0.1)
    .filter((s) => s.freqHz != null)
    .map((s) => symbolForFreq(s.freqHz));
  const noisy = [{ type: "nibble", value: 3 }, { type: "nibble", value: 9 }, ...clean, { type: "nibble", value: 2 }];
  const result = parseSymbolSequence(noisy);
  assert(!result.error, `expected no error, got ${result.error}`);
  assertClose(result.x, 0.6, 1 / 255 + 1e-9);
  assertClose(result.y, 0.1, 1 / 255 + 1e-9);
});

test("parseSymbolSequence reports no-sof when there is no SOF marker", () => {
  const result = parseSymbolSequence([{ type: "nibble", value: 1 }, { type: "eof" }]);
  assertEqual(result.error, "no-sof");
});

test("parseSymbolSequence reports no-eof for an incomplete frame", () => {
  const result = parseSymbolSequence([{ type: "sof" }, { type: "nibble", value: 1 }]);
  assertEqual(result.error, "no-eof");
});

test("parseSymbolSequence rejects a frame with the wrong body length", () => {
  const result = parseSymbolSequence([
    { type: "sof" },
    { type: "nibble", value: 1 },
    { type: "nibble", value: 2 },
    { type: "eof" },
  ]);
  assert(result.error && result.error.startsWith("bad-length"), `expected bad-length error, got ${result.error}`);
});

test("parseSymbolSequence rejects a frame with a corrupted checksum nibble", () => {
  const symbols = buildFrameSymbols(0.4, 0.4)
    .filter((s) => s.freqHz != null)
    .map((s) => symbolForFreq(s.freqHz));
  // last nibble before EOF is the checksum; corrupt it
  const checksumIndex = symbols.length - 2;
  const corruptValue = (symbols[checksumIndex].value + 1) % 16;
  symbols[checksumIndex] = { type: "nibble", value: corruptValue };
  const result = parseSymbolSequence(symbols);
  assertEqual(result.error, "checksum-mismatch");
});
