// peer-voice.js — ブラウザ内リアルタイム声変換(ピッチ+フォルマント)共通モジュール
// peer-patient.html(UE版) / peer-patient-web.html(Web版) から利用。
// DSPは peer-patient.html と同一(Node数値検証済み)。

const PITCH_WORKLET_CODE = `
class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1.0, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.bufferSize = 16384;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.grainSize = 3072; // 約64ms @48k
    this.phase = 0;        // 0..1(グレイン内位相)
  }
  readSample(idx) {
    const N = this.bufferSize;
    idx = ((idx % N) + N) % N;
    const i0 = Math.floor(idx);
    const i1 = (i0 + 1) % N;
    const frac = idx - i0;
    return this.buffer[i0] * (1 - frac) + this.buffer[i1] * frac;
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const inCh = (input && input.length > 0) ? input[0] : null;
    const outCh = output[0];
    const pitch = params.pitch[0];
    const G = this.grainSize;
    const N = this.bufferSize;
    const passthrough = Math.abs(pitch - 1.0) < 1e-3;
    for (let i = 0; i < outCh.length; i++) {
      const s = inCh ? inCh[i] : 0;
      this.buffer[this.writeIndex] = s;
      if (passthrough) {
        outCh[i] = s;
      } else {
        const g1 = this.phase;
        const g2 = (this.phase + 0.5) % 1;
        const d1 = g1 * G;
        const d2 = g2 * G;
        const r1 = this.readSample(this.writeIndex - d1);
        const r2 = this.readSample(this.writeIndex - d2);
        const w1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * g1);
        const w2 = 0.5 - 0.5 * Math.cos(2 * Math.PI * g2);
        outCh[i] = r1 * w1 + r2 * w2;
        this.phase += (1 - pitch) / G;
        if (this.phase >= 1) this.phase -= 1;
        else if (this.phase < 0) this.phase += 1;
      }
      this.writeIndex = (this.writeIndex + 1) % N;
    }
    // 他チャンネルにも同じ出力(モノラル運用)
    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    return true;
  }
}
registerProcessor('pitch-shift', PitchShiftProcessor);
`;

const FORMANT_WORKLET_CODE = `
function fftInPlace(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cwr - im[b] * cwi;
        const xi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = t;
      }
    }
  }
  if (inverse) { for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}
class FormantShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'formant', defaultValue: 1.0, minValue: 0.4, maxValue: 2.5, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.N = 1024; this.H = 256;
    this.win = new Float32Array(this.N);
    for (let n = 0; n < this.N; n++) this.win[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / this.N);
    this.inBuf = new Float32Array(this.N);
    this.outBuf = new Float32Array(this.N);
    this.re = new Float32Array(this.N);
    this.im = new Float32Array(this.N);
    this.mag = new Float32Array(this.N / 2 + 1);
    this.env = new Float32Array(this.N / 2 + 1);
    this.cap = 8192;
    this.inF = new Float32Array(this.cap); this.inH = 0; this.inT = 0; this.inC = 0;
    this.outF = new Float32Array(this.cap); this.outH = 0; this.outT = 0; this.outC = 0;
    this.W = 1.0;
    this.EL = 24;
    this.sw = new Float32Array(2 * this.EL + 1);
    let s = 0;
    for (let d = -this.EL; d <= this.EL; d++) { const w = 0.5 + 0.5 * Math.cos(Math.PI * d / (this.EL + 1)); this.sw[d + this.EL] = w; s += w; }
    for (let i = 0; i < this.sw.length; i++) this.sw[i] /= s;
  }
  ipush(v) { this.inF[this.inT] = v; this.inT = (this.inT + 1) % this.cap; this.inC++; }
  ishift() { const v = this.inF[this.inH]; this.inH = (this.inH + 1) % this.cap; this.inC--; return v; }
  opush(v) { this.outF[this.outT] = v; this.outT = (this.outT + 1) % this.cap; this.outC++; }
  oshift() { if (this.outC <= 0) return 0; const v = this.outF[this.outH]; this.outH = (this.outH + 1) % this.cap; this.outC--; return v; }
  frameProc() {
    const re = this.re, im = this.im, win = this.win, N = this.N, mag = this.mag, env = this.env, sw = this.sw, EL = this.EL;
    const half = N / 2, W = this.W;
    for (let n = 0; n < N; n++) { re[n] = this.inBuf[n] * win[n]; im[n] = 0; }
    fftInPlace(re, im, false);
    if (Math.abs(W - 1) > 1e-4) {
      for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);
      for (let k = 0; k <= half; k++) {
        let a = 0;
        for (let d = -EL; d <= EL; d++) { let idx = k + d; if (idx < 0) idx = -idx; if (idx > half) idx = 2 * half - idx; a += mag[idx] * sw[d + EL]; }
        env[k] = a;
      }
      const eps = 1e-6;
      for (let k = 0; k <= half; k++) {
        const src = k / W;
        let g;
        if (src <= half) { const i0 = Math.floor(src), i1 = Math.min(i0 + 1, half), fr = src - i0; const ne = env[i0] * (1 - fr) + env[i1] * fr; g = ne / (env[k] + eps); }
        else g = 0.0;
        if (g > 4) g = 4; else if (g < 0.15) g = 0.15;
        re[k] *= g; im[k] *= g;
        if (k > 0 && k < half) { re[N - k] *= g; im[N - k] *= g; }
      }
    }
    fftInPlace(re, im, true);
    const norm = 1 / 1.5;
    for (let n = 0; n < N; n++) this.outBuf[n] += re[n] * win[n] * norm;
  }
  hop() {
    const N = this.N, H = this.H;
    this.inBuf.copyWithin(0, H);
    for (let n = 0; n < H; n++) this.inBuf[N - H + n] = this.ishift();
    for (let n = 0; n < H; n++) this.opush(this.outBuf[n]);
    this.outBuf.copyWithin(0, H);
    for (let n = N - H; n < N; n++) this.outBuf[n] = 0;
    this.frameProc();
  }
  process(inputs, outputs, params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const input = inputs[0];
    const inCh = (input && input.length > 0) ? input[0] : null;
    const outCh = output[0];
    this.W = params.formant[0];
    const L = outCh.length;
    for (let i = 0; i < L; i++) this.ipush(inCh ? inCh[i] : 0);
    while (this.inC >= this.H) this.hop();
    for (let i = 0; i < L; i++) outCh[i] = this.oshift();
    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    return true;
  }
}
registerProcessor('formant-shift', FormantShiftProcessor);
`;

export const semitoneToRatio = (semi) => Math.pow(2, Number(semi) / 12);

// ペルソナ既定値: p=半音, f=フォルマント目標(相対)
export const PERSONAS = {
  none: { p: 0,  f: 1.00 },
  kd:   { p: -4, f: 0.88 },
  cd:   { p: -2, f: 0.94 },
  jd:   { p: -1, f: 1.00 },
  kj:   { p: 2,  f: 1.10 },
  cj:   { p: 4,  f: 1.16 },
  jj:   { p: 7,  f: 1.24 },
};

export class VoiceConverter {
  constructor() { this.ctx = null; this.src = null; this.pitch = null; this.formant = null; this.dest = null; }
  async start(micStream) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") { try { await this.ctx.resume(); } catch (e) {} }
    for (const code of [PITCH_WORKLET_CODE, FORMANT_WORKLET_CODE]) {
      const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    }
    this.src = this.ctx.createMediaStreamSource(micStream);
    this.pitch = new AudioWorkletNode(this.ctx, "pitch-shift", { outputChannelCount: [1] });
    this.formant = new AudioWorkletNode(this.ctx, "formant-shift", { outputChannelCount: [1] });
    this.dest = this.ctx.createMediaStreamDestination();
    this.src.connect(this.pitch).connect(this.formant).connect(this.dest);
    return this.dest.stream.getAudioTracks()[0];
  }
  // semi=半音, formantTarget=太さ(相対)。フォルマント段には W=target/pitchRatio を渡す。
  setVoice(semi, formantTarget) {
    const pr = semitoneToRatio(semi);
    const W = formantTarget / pr;
    const t = this.ctx ? this.ctx.currentTime : 0;
    if (this.pitch) this.pitch.parameters.get("pitch").setValueAtTime(pr, t);
    if (this.formant) this.formant.parameters.get("formant").setValueAtTime(W, t);
  }
  stop() {
    try { this.src && this.src.disconnect(); } catch (e) {}
    try { this.pitch && this.pitch.disconnect(); } catch (e) {}
    try { this.formant && this.formant.disconnect(); } catch (e) {}
    try { this.dest && this.dest.disconnect(); } catch (e) {}
    try { this.ctx && this.ctx.close(); } catch (e) {}
    this.src = this.pitch = this.formant = this.dest = this.ctx = null;
  }
}
