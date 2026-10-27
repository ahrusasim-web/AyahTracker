/**
 * Streaming windowed-sinc resampler (any input rate → 16 kHz by default).
 * Band-limits to 95% of the output Nyquist so 48/44.1 kHz microphone audio does not alias
 * into the speech band. Keeps state across chunks so there are no seams.
 */
export class Resampler {
  readonly inRate: number;
  readonly outRate: number;
  private readonly step: number; // input samples per output sample
  private readonly half: number; // kernel half-width in input samples
  private readonly fc: number; // cutoff, cycles per input sample
  private buf: Float32Array;
  private bufLen = 0;
  private pos = 0; // fractional read position of the next output sample within buf
  private readonly table: Float32Array;
  private readonly tableRes = 512;

  constructor(inRate: number, outRate = 16000, zeroCrossings = 16) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate;
    this.fc = (0.95 * 0.5 * Math.min(inRate, outRate)) / inRate;
    this.half = Math.ceil(zeroCrossings / (2 * this.fc));
    this.buf = new Float32Array(Math.max(8192, this.half * 4));
    this.pos = this.half; // start with half a kernel of zero history
    this.bufLen = this.half;
    // Precomputed kernel: h(d) = 2fc·sinc(2fc·d)·blackman(d), d in input samples, |d| <= half
    const n = this.half * this.tableRes;
    this.table = new Float32Array(n + 2);
    for (let i = 0; i <= n + 1; i++) {
      const d = i / this.tableRes;
      const x = 2 * this.fc * d;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = d > this.half ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * d) / this.half) + 0.08 * Math.cos((2 * Math.PI * d) / this.half);
      this.table[i] = 2 * this.fc * sinc * w;
    }
  }

  private kernel(d: number): number {
    const a = Math.abs(d) * this.tableRes;
    const i = Math.floor(a);
    if (i >= this.table.length - 1) return 0;
    const f = a - i;
    return this.table[i]! * (1 - f) + this.table[i + 1]! * f;
  }

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input.slice();
    if (this.bufLen + input.length > this.buf.length) {
      const nb = new Float32Array((this.bufLen + input.length) * 2);
      nb.set(this.buf.subarray(0, this.bufLen));
      this.buf = nb;
    }
    this.buf.set(input, this.bufLen);
    this.bufLen += input.length;
    const outCap = Math.ceil((this.bufLen - this.pos) / this.step) + 2;
    const out = new Float32Array(Math.max(0, outCap));
    let n = 0;
    while (this.pos + this.half < this.bufLen) {
      const c = Math.floor(this.pos);
      const frac = this.pos - c;
      let acc = 0;
      for (let k = -this.half + 1; k <= this.half; k++) {
        acc += this.buf[c + k]! * this.kernel(k - frac);
      }
      out[n++] = acc;
      this.pos += this.step;
    }
    // Drop consumed input, keep `half` samples of history before the read position.
    const keepFrom = Math.max(0, Math.floor(this.pos) - this.half);
    if (keepFrom > 0) {
      this.buf.copyWithin(0, keepFrom, this.bufLen);
      this.bufLen -= keepFrom;
      this.pos -= keepFrom;
    }
    return out.subarray(0, n);
  }
}
