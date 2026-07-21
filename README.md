# Ultrasound Coordinate Test

A tiny, framework-free web page for testing data transfer over near-ultrasonic
sound between two devices/browser tabs. One instance runs in **Transmit**
mode: tap inside the square and it plays your tap's normalized `(x, y)`
coordinate as a short sequence of tones. Any instance in **Listen** mode
picks it up through the microphone and draws the received point.

## Research summary

**Why "near-ultrasonic" (~18-20 kHz) and not true ultrasound (>20 kHz)?**
Standard Web Audio (`AudioContext`) and `getUserMedia` streams commonly run
at 44.1 kHz or 48 kHz, which caps representable frequency (Nyquist limit) at
22.05/24 kHz — true ultrasound leaves almost no headroom and many phone
mic/speaker frequency responses roll off sharply above 20 kHz since they're
tuned for voice/music, not ultrasound. The commonly used "sweet spot" for
inaudible-to-most-adults, browser-reproducible tones is **18-20 kHz**: most
adult hearing falls off well before 18 kHz, consumer speakers reproduce it
fine, and mics — while not optimized for it — can still pick it up. This is
the same band used by commercial/production systems like Shopkick and by
[ggwave](https://github.com/ggerganov/ggwave) (an open-source data-over-sound
library), which uses an ultrasonic base frequency around 15 kHz and reports
roughly **8-16 bytes/sec** in its robust modes, up into the hundreds of
bytes/sec in its fastest (less reliable, more audible) modes using several
simultaneous tones per symbol.

**Modulation.** We use multi-frequency shift keying (MFSK): each 4-bit
nibble is transmitted as one of 16 discrete tones spaced 100 Hz apart, plus
two reserved marker tones for start/end-of-frame. This is essentially the
same idea as DTMF, just with more tones and shifted up out of the audible
range. It's simple to encode (`OscillatorNode` frequency changes) and decode
(pick the loudest FFT bin in the band) — a good fit for "keep it simple."

**Why single-tone symbols instead of ggwave-style multi-tone-at-once?**
Sending several simultaneous tones (like ggwave's 6-tones-in-parallel scheme)
roughly multiplies throughput, but multiplies decoder complexity too. Since
this is explicitly a *test/estimation* build, we send one tone at a time with
a short silence gap between symbols — the gap makes receiver framing
(deciding where one symbol ends and the next begins) trivial without a
tightly synchronized clock, at the cost of speed.

## Frame format

```
[ SOF ] [ xHi ] [ xLo ] [ yHi ] [ yLo ] [ checksum ] [ EOF ]
```

- `x` and `y` are each quantized to 8 bits (256 levels, ~0.4% resolution)
  and split into a high/low nibble.
- `checksum` is the XOR of the 4 payload nibbles — enough to reject a frame
  if any single nibble was misheard, which is the dominant failure mode over
  a noisy acoustic channel.
- Each symbol (tone or silence) is defined in [js/codec.js](js/codec.js)
  under `CONFIG`: 120 ms tone + 40 ms silence gap, tones from 18000 Hz to
  19900 Hz in 100 Hz steps.

## Bandwidth estimate

With the default config, one full frame (7 tones + 6 gaps) takes
**~1.08 seconds** and carries 16 payload bits, i.e. roughly:

- **~15 bits/sec effective** (including framing overhead) for this
  conservative, single-tone, gap-separated scheme.
- Raw symbol rate before overhead is `1000 / (120+40) = 6.25 symbols/sec`,
  and each symbol carries 4 bits → ~25 bps raw.

This is deliberately on the slow-and-reliable end. Faster configurations are
possible by shrinking `symbolMs`/`gapMs`, using more simultaneous tones per
symbol (ggwave-style), or adding forward error correction instead of a
detect-and-drop checksum — those would trade the "simple to reason about and
debug" property of this build for throughput, likely landing somewhere in
the tens-to-low-hundreds of bps range that similar libraries report.

**Multiple simultaneous transmitters:** not currently handled — two
transmitters at once would produce overlapping tones the receiver can't
separate (this single-tone-peak-detection approach has no multi-user access
scheme). A real multi-transmitter design would need either frequency-division
(give each transmitter its own sub-band), time-division (transmitters take
turns, e.g. slotted like Wi-Fi's CSMA), or a code-division scheme — all
useful follow-ups if this test moves toward a "stream" use case.

## Running the app

Needs to be served over HTTP(S) — `file://` won't work because it's built
from ES modules and `getUserMedia` requires a secure context. From this
directory:

```sh
python3 -m http.server 8080
# or: npx serve .
```

Then open `http://localhost:8080/` on each device/tab you want to test
with. To test across two separate devices (e.g. two phones, or a phone and a
laptop) rather than two tabs on one machine, `getUserMedia` requires HTTPS
except on `localhost` — use a tool like `ngrok`/a self-signed cert/your
router's LAN + a reverse proxy with TLS if you need cross-device testing over
a network.

**Before testing:** turn your device volume up enough for the ~18-20 kHz
tones to be audible to the mic (they should be faint/inaudible to most
adult ears but some people, especially younger listeners, may still hear a
faint tone), and grant microphone permission when prompted in Listen mode.

## Running the tests

There's no Node dependency — tests run directly in a browser against plain
ES modules. With the server above running, open:

```
http://localhost:8080/test.html
```

It runs a small dependency-free assertion harness
([test/tiny-test.js](test/tiny-test.js)) against
[test/codec.test.js](test/codec.test.js), which covers the pure
encode/decode logic in [js/codec.js](js/codec.js): quantization round-trips,
frequency↔symbol mapping, checksum corruption detection, frame building, and
full encode→transmit-symbols→receive-symbols→decode round trips. Results
show on the page and are also logged to the console as a single
`TEST_RESULT PASS/FAIL ...` line for scripting/CI.

The transmit/receive audio I/O itself (`js/transmitter.js`,
`js/receiver.js`) isn't unit tested since it requires real speaker/mic
hardware — it's a thin layer over the tested codec logic, exercised by
actually running the app.

## Files

- `js/codec.js` — pure encode/decode logic (unit tested)
- `js/transmitter.js` — Web Audio playback of a coordinate
- `js/receiver.js` — microphone FFT + tone decoding
- `js/app.js` — UI wiring (canvas, mode toggle, log)
- `test/` — browser-based unit tests
- `index.html`, `css/style.css` — the app shell
