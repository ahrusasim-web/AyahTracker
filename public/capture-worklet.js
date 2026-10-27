// Microphone capture: mixes to mono and sends ~85 ms blocks (at the context's sample rate)
// straight to the recognition worker over a transferred MessagePort. No processing here;
// resampling and conditioning happen in the worker so the browser and the benchmark run
// exactly the same code.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.size = 4096;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.out = e.data.port;
      if (e.data && e.data.flush) this.flush();
    };
  }
  flush() {
    if (!this.out || this.n === 0) return;
    const block = this.buf.slice(0, this.n);
    this.out.postMessage({ type: "audio", samples: block, rate: sampleRate, at: currentTime }, [block.buffer]);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    const chans = input.length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += input[c][i];
      this.buf[this.n++] = s / chans;
      if (this.n === this.size) {
        if (this.out) {
          const block = this.buf;
          this.out.postMessage({ type: "audio", samples: block, rate: sampleRate, at: currentTime }, [block.buffer]);
          this.buf = new Float32Array(this.size);
        }
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("ayah-capture", CaptureProcessor);
