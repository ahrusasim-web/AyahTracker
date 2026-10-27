/**
 * Light-touch audio conditioning for distant recitation, at 16 kHz mono.
 *
 *  1. High-pass (2nd-order Butterworth, 70 Hz): removes rumble, handling and footstep thumps
 *     without touching the voice.
 *  2. Slow automatic gain: brings speech to a steady level (target ≈ -24 dBFS) using a level
 *     estimate taken only from frames that stand clearly above the noise floor, so silence
 *     and noise are never pumped up. Gain rises slowly (≈2 s) and falls quickly (≈0.15 s).
 *  3. Soft limiter: sudden loud sounds (a cough next to the phone) are rounded off instead of
 *     clipping, and never drag the gain down for long.
 *
 * Deliberately no spectral noise suppression: it removes breathy consonants and the long
 * vowels of tajweed that the recogniser relies on. The quality metrics feed the tracker so
 * that evidence heard through poor audio counts for less.
 */
export interface ConditionerOptions {
  enabled: boolean;
  targetDb: number;
  maxGainDb: number;
  minGainDb: number;
  highpassHz: number;
}

export const DEFAULT_CONDITIONER: ConditionerOptions = {
  enabled: true,
  targetDb: -24,
  maxGainDb: 30,
  minGainDb: -6,
  highpassHz: 70,
};

export interface AudioQuality {
  /** Estimated speech-to-noise ratio of the recent audio (dB). */
  snrDb: number;
  /** Fraction of input samples at or near full scale. */
  clipping: number;
  /** Input level of the louder frames (dBFS, before gain). */
  levelDb: number;
  /** Whether this chunk contained speech-like energy above the noise floor. */
  speech: boolean;
  /** Current applied gain (dB). */
  gainDb: number;
}

const SR = 16000;
const FRAME = 320; // 20 ms
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
const lin = (d: number) => Math.pow(10, d / 20);

export class AudioConditioner {
  opts: ConditionerOptions;
  // biquad state
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private gainDb = 0;
  private noiseDb = -60;
  private speechDb = -30;
  private frameBuf = new Float32Array(FRAME);
  private frameFill = 0;
  private speechFrames = 0;
  private framesSeen = 0;
  private clipCount = 0;
  private sampleCount = 0;
  private recentSpeech = false;
  private peakLevelDb = -90;

  constructor(opts: Partial<ConditionerOptions> = {}) {
    this.opts = { ...DEFAULT_CONDITIONER, ...opts };
    this.design();
  }

  private design(): void {
    const w0 = (2 * Math.PI * this.opts.highpassHz) / SR;
    const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.gainDb = 0;
    this.noiseDb = -60;
    this.speechDb = -30;
    this.frameFill = 0;
  }

  /** Process a chunk in place-safe fashion; returns the conditioned copy and quality metrics. */
  process(input: Float32Array): { out: Float32Array; quality: AudioQuality } {
    const out = new Float32Array(input.length);
    this.speechFrames = 0;
    this.framesSeen = 0;
    this.clipCount = 0;
    this.sampleCount = input.length;
    this.peakLevelDb = -90;
    let g = lin(this.gainDb);
    for (let i = 0; i < input.length; i++) {
      const x = input[i]!;
      if (Math.abs(x) >= 0.985) this.clipCount++;
      // high-pass
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      this.frameBuf[this.frameFill++] = y;
      if (this.frameFill === FRAME) {
        this.updateLevels();
        g = lin(this.gainDb);
        this.frameFill = 0;
      }
      if (!this.opts.enabled) {
        out[i] = x;
        continue;
      }
      out[i] = softLimit(y * g);
    }
    const quality: AudioQuality = {
      snrDb: this.speechDb - this.noiseDb,
      clipping: this.sampleCount ? this.clipCount / this.sampleCount : 0,
      levelDb: this.peakLevelDb,
      speech: this.framesSeen > 0 && this.speechFrames / this.framesSeen > 0.2,
      gainDb: this.opts.enabled ? this.gainDb : 0,
    };
    return { out, quality };
  }

  private updateLevels(): void {
    let e = 0;
    for (let i = 0; i < FRAME; i++) e += this.frameBuf[i]! * this.frameBuf[i]!;
    const L = db(Math.sqrt(e / FRAME));
    this.framesSeen++;
    if (L > this.peakLevelDb) this.peakLevelDb = L;
    // Noise floor: follows quiet frames down immediately, creeps up ~3 dB/s otherwise.
    if (L < this.noiseDb) this.noiseDb = 0.7 * this.noiseDb + 0.3 * L;
    else this.noiseDb += 0.06;
    const isSpeech = L > this.noiseDb + 9 && L > -75;
    if (isSpeech) {
      this.speechFrames++;
      // Speech level: fast up, slow down (tracks the loud parts of recitation).
      const a = L > this.speechDb ? 0.15 : 0.02;
      this.speechDb += a * (L - this.speechDb);
    }
    this.recentSpeech = isSpeech;
    if (!this.opts.enabled) return;
    const want = Math.max(this.opts.minGainDb, Math.min(this.opts.maxGainDb, this.opts.targetDb - this.speechDb));
    // Never lift the noise floor above -35 dBFS.
    const capped = Math.min(want, -35 - this.noiseDb);
    const target = Math.max(this.opts.minGainDb, capped);
    const rate = target > this.gainDb ? 0.01 : 0.12; // per 20 ms frame: ≈2 s up, ≈0.15 s down
    this.gainDb += rate * (target - this.gainDb);
  }
}

function softLimit(x: number): number {
  const t = 0.7;
  const a = Math.abs(x);
  if (a <= t) return x;
  const over = (a - t) / (1 - t);
  const y = t + (1 - t) * Math.tanh(over);
  return x < 0 ? -y : y;
}
