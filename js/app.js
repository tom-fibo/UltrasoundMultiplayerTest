import { Transmitter } from "./transmitter.js";
import { Receiver } from "./receiver.js";
import { frameDurationMs, CONFIG } from "./codec.js";

const canvas = document.getElementById("square");
const ctx = canvas.getContext("2d");
const modeToggle = document.getElementById("modeToggle");
const volumeInput = document.getElementById("volume");
const sentReadout = document.getElementById("sentReadout");
const receivedReadout = document.getElementById("receivedReadout");
const liveTone = document.getElementById("liveTone");
const logEl = document.getElementById("log");

let mode = "transmit"; // 'transmit' | 'listen'
let lastSent = null;
let lastReceived = null;
let lastDebugUpdate = 0;

const transmitter = new Transmitter();
const receiver = new Receiver({
  onDecode: (coord) => {
    lastReceived = coord;
    receivedReadout.textContent = fmtCoord(coord);
    log(`Received x=${coord.x.toFixed(3)} y=${coord.y.toFixed(3)}`, "received");
    draw();
  },
  onDebug: ({ freqHz, dB, symbol }) => {
    const now = performance.now();
    if (now - lastDebugUpdate < 100) return;
    lastDebugUpdate = now;
    if (freqHz == null) {
      liveTone.textContent = "silence";
    } else {
      const label = symbol ? symbolLabel(symbol) : "unknown";
      liveTone.textContent = `${freqHz.toFixed(0)} Hz (${dB.toFixed(0)} dB) - ${label}`;
    }
  },
  onError: (err) => log(`Mic error: ${err.message}`, "error"),
});

function symbolLabel(symbol) {
  if (symbol.type === "sof") return "SOF";
  if (symbol.type === "eof") return "EOF";
  return `nibble ${symbol.value.toString(16).toUpperCase()}`;
}

function fmtCoord(c) {
  return `x=${c.x.toFixed(3)} y=${c.y.toFixed(3)}`;
}

function log(message, cls) {
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString();
  li.textContent = `[${time}] ${message}`;
  if (cls) li.className = cls;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(128,128,128,0.3)";
  ctx.lineWidth = 1;
  const steps = 10;
  for (let i = 1; i < steps; i++) {
    const p = (i / steps) * w;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, h);
    ctx.moveTo(0, p);
    ctx.lineTo(w, p);
    ctx.stroke();
  }

  if (lastSent) drawMarker(lastSent, "#2b7de9", "X");
  if (lastReceived) drawMarker(lastReceived, "#e9702b", "O");
}

function drawMarker(coord, color, shape) {
  const w = canvas.width;
  const h = canvas.height;
  const px = coord.x * w;
  const py = coord.y * h;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  const r = 12;
  if (shape === "X") {
    ctx.beginPath();
    ctx.moveTo(px - r, py - r);
    ctx.lineTo(px + r, py + r);
    ctx.moveTo(px + r, py - r);
    ctx.lineTo(px - r, py + r);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

async function handleCanvasTap(evt) {
  if (mode !== "transmit") return;
  const rect = canvas.getBoundingClientRect();
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));

  lastSent = { x, y };
  sentReadout.textContent = fmtCoord(lastSent);
  draw();

  const volume = parseFloat(volumeInput.value);
  log(`Sending x=${x.toFixed(3)} y=${y.toFixed(3)} (frame ~${frameDurationMs()}ms)`, "sent");
  try {
    await transmitter.send(x, y, { volume });
  } catch (err) {
    log(`Send error: ${err.message}`, "error");
  }
}

canvas.addEventListener("click", handleCanvasTap);
canvas.addEventListener(
  "touchstart",
  (evt) => {
    evt.preventDefault();
    handleCanvasTap(evt);
  },
  { passive: false }
);

modeToggle.addEventListener("click", async () => {
  if (mode === "transmit") {
    mode = "listen";
    modeToggle.textContent = "Mode: Listen";
    modeToggle.setAttribute("aria-pressed", "true");
    canvas.style.cursor = "default";
    try {
      await receiver.start();
      log("Listening for near-ultrasonic tones...", null);
    } catch (err) {
      log(`Could not start microphone: ${err.message}`, "error");
    }
  } else {
    mode = "transmit";
    modeToggle.textContent = "Mode: Transmit";
    modeToggle.setAttribute("aria-pressed", "false");
    canvas.style.cursor = "crosshair";
    receiver.stop();
    liveTone.textContent = "-";
    log("Stopped listening.", null);
  }
});

log(
  `Ready. Tone band ${CONFIG.toneBaseHz}-${CONFIG.eofHz} Hz, frame ~${frameDurationMs()}ms.`,
  null
);
draw();
