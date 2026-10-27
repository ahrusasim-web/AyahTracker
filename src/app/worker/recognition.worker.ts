/// <reference lib="webworker" />
import * as ort from "onnxruntime-web/wasm";
import { TilawaRecognizer } from "../../core/engine/recognizer";
import { RecognitionPipeline, type PipelineEvent } from "../../core/pipeline";
import { Resampler } from "../../core/audio/resampler";
import type { EngineSettings, FromWorker, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const MODEL = "models/zipformer_a0w_ep1_a05.int8.onnx";
const CORPUS = "models/zipformer_quran.json";
const TEXT = "models/quran.json";
const CACHE = "ayah-live-models-v1";

let pipeline: RecognitionPipeline | null = null;
let resampler: Resampler | null = null;
let listening = false;
let settings: EngineSettings | null = null;
let chain: Promise<void> = Promise.resolve();
let queuedSamples = 0;
let inRate = 48000;
let lastStats = 0;
/** If processing falls this far behind, drop audio until it catches up, then restart cleanly. */
const MAX_BACKLOG = 15 * 16000;
let dropping = false;
/** Incremented on every start, so audio queued by a previous session is never processed. */
let sessionId = 0;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

/** Fetch with progress, served from Cache Storage after the first download. */
async function fetchCached(url: string, stage: "model" | "corpus" | "text"): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      post({ type: "loading", stage, loaded: buf.byteLength, total: buf.byteLength, cached: true });
      return buf;
    }
  } catch {
    cache = null; // Cache Storage unavailable (private mode, some WebViews)
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url.split("/").pop()} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body?.getReader();
  let buf: ArrayBuffer;
  if (!reader) {
    buf = await res.arrayBuffer();
  } else {
    const parts: Uint8Array[] = [];
    let loaded = 0, lastPost = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.byteLength;
      if (loaded - lastPost > 1 << 20) {
        lastPost = loaded;
        post({ type: "loading", stage, loaded, total, cached: false });
      }
    }
    const all = new Uint8Array(loaded);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.byteLength; }
    buf = all.buffer;
  }
  post({ type: "loading", stage, loaded: buf.byteLength, total: buf.byteLength, cached: false });
  try {
    await cache?.put(url, new Response(buf.slice(0), { headers: { "content-type": "application/octet-stream" } }));
  } catch {
    /* quota: keep working without the cache */
  }
  return buf;
}

async function init(baseUrl: string, s: EngineSettings): Promise<void> {
  const t0 = performance.now();
  settings = s;
  const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  // The WebAssembly runtime is bundled by Vite next to this worker (no wasmPaths needed).
  ort.env.wasm.numThreads = threads;
  post({ type: "loading", stage: "runtime", loaded: 0, total: 1, cached: false });
  const [model, corpus, text] = await Promise.all([
    fetchCached(new URL(MODEL, baseUrl).href, "model"),
    fetchCached(new URL(CORPUS, baseUrl).href, "corpus"),
    fetchCached(new URL(TEXT, baseUrl).href, "text"),
  ]);
  const dec = new TextDecoder();
  const rec = await TilawaRecognizer.create({
    ort,
    model: new Uint8Array(model),
    corpus: JSON.parse(dec.decode(corpus)),
    quran: JSON.parse(dec.decode(text)),
    executionProviders: ["wasm"],
  });
  pipeline = new RecognitionPipeline(rec, {
    tracker: { prayer: s.prayer, sensitivity: s.sensitivity },
    conditioner: { enabled: s.conditioning },
  });
  post({ type: "ready", recognizer: rec.name, threads, loadMs: Math.round(performance.now() - t0) });
}

function applySettings(s: EngineSettings): void {
  settings = s;
  if (!pipeline) return;
  pipeline.tracker.cfg = { ...pipeline.tracker.cfg, prayer: s.prayer, sensitivity: s.sensitivity };
  pipeline.conditioner.opts = { ...pipeline.conditioner.opts, enabled: s.conditioning };
}

function onAudio(samples: Float32Array, rate: number): void {
  if (!listening || !pipeline) return;
  if (!resampler || resampler.inRate !== rate) resampler = new Resampler(rate, 16000);
  const pcm = resampler.process(samples);
  if (dropping || queuedSamples > MAX_BACKLOG) {
    if (!dropping) {
      dropping = true;
      post({ type: "error", message: "This device fell behind the recitation; skipping ahead to catch up.", fatal: false });
    }
    if (queuedSamples > 3 * 16000) return;
    dropping = false;
    const pg = pipeline;
    chain = chain.then(() => {
      if (pg === pipeline) post({ type: "events", events: pg.gap() });
    });
  }
  queuedSamples += pcm.length;
  const p = pipeline;
  const sid = sessionId;
  chain = chain.then(async () => {
    if (!listening || p !== pipeline || sid !== sessionId) {
      if (sid === sessionId) queuedSamples -= pcm.length;
      return;
    }
    try {
      const events: PipelineEvent[] = await p.push(pcm);
      queuedSamples -= pcm.length;
      if (events.length) post({ type: "events", events });
      const now = performance.now();
      if (now - lastStats > 2000) {
        lastStats = now;
        const st = p.stats;
        post({ type: "stats", rtf: st.audioSec ? st.computeMs / 1000 / st.audioSec : 0, backlogSec: queuedSamples / 16000, audioSec: st.audioSec, maxChunkMs: st.maxChunkMs });
      }
    } catch (e) {
      queuedSamples -= pcm.length;
      post({ type: "error", message: e instanceof Error ? e.message : String(e), fatal: false });
    }
  });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "init":
      init(m.baseUrl, m.settings).catch((err) => post({ type: "error", message: err instanceof Error ? err.message : String(err), fatal: true }));
      break;
    case "audio-port":
      m.port.onmessage = (ev: MessageEvent<{ type: "audio"; samples: Float32Array; rate: number }>) => {
        if (ev.data?.type === "audio") onAudio(ev.data.samples, ev.data.rate);
      };
      break;
    case "start":
      sessionId++;
      dropping = false;
      inRate = m.sampleRate;
      resampler = new Resampler(inRate, 16000);
      queuedSamples = 0;
      pipeline?.restart();
      if (settings) applySettings(settings);
      listening = true;
      break;
    case "stop":
      listening = false;
      chain = chain.then(() => post({ type: "stopped" }));
      break;
    case "settings":
      applySettings(m.settings);
      break;
  }
};
