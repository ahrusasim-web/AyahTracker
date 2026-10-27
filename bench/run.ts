/**
 * Benchmark harness: streams the benchmark corpus through recognition variants in real
 * chunk sizes, exactly as the app does, and scores the confirmed verse sequences.
 *
 *   npx tsx bench/run.ts --data <corpus-dir> [--variants tracker,baseline] [--conds clean,hall]
 *        [--kinds single,salah] [--limit N] [--out results.json] [--set key=value ...]
 *
 * Metrics per (variant, condition, kind):
 *   recall      expected verses confirmed (identical-text equivalents count, as in Tilawi's eval)
 *   wrong       confirmed verses that were not recited (insertions) — the costly error
 *   precision   correct / all confirmed
 *   exact       streams whose confirmed sequence is exactly right
 *   latency     single verses: confirmation time after the verse audio began / ended (s)
 *   RTF         recogniser compute time / audio time on this machine
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as ort from "onnxruntime-node";
import { createZipformerSession, createRecognitionSession, type WorkerOutbound } from "@tilawa/core";
import { TilawaRecognizer } from "../src/core/engine/recognizer";
import { RecognitionPipeline } from "../src/core/pipeline";
import { quranIndex, key, type VerseRef } from "../src/core/quran/quranIndex";

const args = process.argv.slice(2);
const arg = (n: string, d?: string) => {
  const i = args.indexOf("--" + n);
  return i >= 0 ? args[i + 1] : d;
};
const DATA = arg("data")!;
const MODELS = new URL("../public/models/", import.meta.url).pathname;
const DL = new URL("../assets-dl/", import.meta.url).pathname;
const variants = arg("variants", "tracker,baseline")!.split(",");
const conds = arg("conds", "clean,mild,hall,pocket")!.split(",");
const kinds = arg("kinds", "single,salah,midstart,noise")!.split(",");
const limit = Number(arg("limit", "100000"));
const outFile = arg("out");
const sets: Record<string, string> = {};
args.forEach((a, i) => { if (a === "--set") { const [k, v] = args[i + 1]!.split("="); sets[k!] = v!; } });

interface Stream { id: string; cond: string; kind: string; file: string; duration: number; expected: number[][]; optional: unknown[]; segments: [number, number][] }
const manifest: { streams: Stream[] } = JSON.parse(readFileSync(`${DATA}/manifest.json`, "utf8"));

function loadWav(path: string): Float32Array {
  const buf = execFileSync("ffmpeg", ["-v", "quiet", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

interface Confirmation { v: VerseRef; t: number; via?: string; late?: boolean }
interface RunResult { confirmations: Confirmation[]; computeMs: number; audioSec: number }

const CHUNK = 5120;
const modelBytes = readFileSync(MODELS + "zipformer_a0w_ep1_a05.int8.onnx");
const corpus = JSON.parse(readFileSync(MODELS + "zipformer_quran.json", "utf8"));
const quran = JSON.parse(readFileSync(MODELS + "quran.json", "utf8"));

// --- variant runners --------------------------------------------------------------------

type Runner = (pcm: Float32Array) => Promise<RunResult>;

async function trackerRunner(prep: boolean): Promise<Runner> {
  const rec = await TilawaRecognizer.create({ ort, model: modelBytes, corpus, quran });
  const pipe = new RecognitionPipeline(rec, {
    conditioner: { enabled: prep },
    tracker: { sensitivity: (sets.sensitivity as never) ?? "balanced", prayer: (sets.prayer as never) ?? "general" },
    pauseResetSec: Number(sets.pause ?? 4),
  });
  return async (pcm) => {
    pipe.restart();
    const conf: Confirmation[] = [];
    const byId = new Map<number, Confirmation>();
    for (let i = 0; i < pcm.length; i += CHUNK) {
      const evs = await pipe.push(pcm.subarray(i, Math.min(pcm.length, i + CHUNK)));
      for (const e of evs) {
        if (e.type === "confirmed") {
          const c: Confirmation = { v: e.entry.v, t: e.entry.t, via: e.entry.via, late: e.entry.late };
          // A late entry belongs before the verse that follows it, as in the app's history.
          const at = c.late ? conf.findLastIndex((x) => x.v.s === c.v.s && x.v.a === c.v.a + 1) : -1;
          if (at >= 0) conf.splice(at, 0, c); else conf.push(c);
          byId.set(e.entry.id, c);
        }
        if (e.type === "revised") { const c = byId.get(e.id); if (c) c.v = e.v; }
      }
    }
    return { confirmations: conf, computeMs: pipe.stats.computeMs, audioSec: pipe.stats.audioSec };
  };
}

async function baselineRunner(): Promise<Runner> {
  const session = await createZipformerSession({ ort, model: modelBytes, corpus, quran });
  return async (pcm) => {
    session.reset();
    const conf: Confirmation[] = [];
    let ms = 0;
    for (let i = 0; i < pcm.length; i += CHUNK) {
      const t0 = performance.now();
      const msgs = await session.feed(pcm.subarray(i, Math.min(pcm.length, i + CHUNK)));
      ms += performance.now() - t0;
      const t = Math.min(pcm.length, i + CHUNK) / 16000;
      for (const m of msgs) if (m.type === "verse_match") conf.push({ v: { s: m.surah, a: m.ayah }, t });
    }
    return { confirmations: conf, computeMs: ms, audioSec: pcm.length / 16000 };
  };
}

async function fastConformerRunner(): Promise<Runner> {
  const fcBytes = readFileSync(DL + "fastconformer_full_mixed.onnx");
  const sess = await ort.InferenceSession.create(fcBytes, { executionProviders: ["cpu"] });
  const runner = {
    async run(audio: Float32Array) {
      const input = new ort.Tensor("float32", audio, [1, audio.length]);
      const length = new ort.Tensor("int64", BigInt64Array.from([BigInt(audio.length)]), [1]);
      const res = await sess.run({ audio_signal: input, length });
      const o = res[sess.outputNames[0]!]!;
      const [, timeSteps, vocabSize] = o.dims as number[];
      return { logprobs: o.data as Float32Array, timeSteps: timeSteps!, vocabSize: vocabSize! };
    },
  };
  const assets = {
    vocab: JSON.parse(readFileSync(DL + "vocab.json", "utf8")),
    quranCtcTokens: JSON.parse(readFileSync(DL + "quran_ctc_tokens.json", "utf8")),
    quran,
  };
  return async (pcm) => {
    const s = await createRecognitionSession({ engine: "fastconformer", runner, assets } as never);
    const conf: Confirmation[] = [];
    let ms = 0;
    for (let i = 0; i < pcm.length; i += CHUNK) {
      const t0 = performance.now();
      const msgs: WorkerOutbound[] = await s.feed(pcm.subarray(i, Math.min(pcm.length, i + CHUNK)));
      ms += performance.now() - t0;
      const t = Math.min(pcm.length, i + CHUNK) / 16000;
      for (const m of msgs) if (m.type === "verse_match") conf.push({ v: { s: m.surah, a: m.ayah }, t });
    }
    return { confirmations: conf, computeMs: ms, audioSec: pcm.length / 16000 };
  };
}

// --- scoring --------------------------------------------------------------------------------

const equiv = (a: VerseRef, b: VerseRef) => quranIndex.identicalGroup(a).some((g) => g.s === b.s && g.a === b.a);

function score(stream: Stream, conf: Confirmation[]) {
  const E: VerseRef[] = stream.expected.map(([s, a]) => ({ s: s!, a: a! }));
  const opt: VerseRef[] = [];
  for (const o of stream.optional as unknown[]) {
    if (Array.isArray(o) && typeof o[0] === "number") opt.push({ s: o[0] as number, a: o[1] as number });
    else if (Array.isArray(o)) for (const p of o as number[][]) opt.push({ s: p[0]!, a: p[1]! });
  }
  const C = conf.map((c) => c.v);
  // LCS with equivalence
  const n = E.length, m = C.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i]![j] = equiv(E[i - 1]!, C[j - 1]!) ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  const hits = dp[n]![m]!;
  // matched indices in C
  const matchedC = new Set<number>();
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (equiv(E[i - 1]!, C[j - 1]!) && dp[i]![j] === dp[i - 1]![j - 1]! + 1) { matchedC.add(j - 1); i--; j--; }
    else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--;
    else j--;
  }
  let wrong = 0, optionalHits = 0;
  const wrongList: string[] = [];
  C.forEach((c, idx) => {
    if (matchedC.has(idx)) return;
    if (opt.some((o) => equiv(o, c))) { optionalHits++; return; }
    // a correct verse confirmed twice (e.g. repeated) where the expected sequence has it once
    wrong++;
    wrongList.push(key(c));
  });
  let latencyStart: number | null = null, latencyEnd: number | null = null;
  if (stream.kind === "single" && hits > 0 && stream.segments.length) {
    const first = conf.find((c) => equiv(E[0]!, c.v));
    if (first) { latencyStart = first.t - stream.segments[0]![0]; latencyEnd = first.t - stream.segments[0]![1]; }
  }
  return { expected: n, hits, wrong, wrongList, optionalHits, confirmed: m, exact: hits === n && wrong === 0, latencyStart, latencyEnd };
}

// --- main -----------------------------------------------------------------------------------

const pick = manifest.streams.filter((s) => conds.includes(s.cond) && kinds.includes(s.kind));
const byGroup = new Map<string, Stream[]>();
for (const s of pick) {
  const g = `${s.cond}|${s.kind}`;
  if (!byGroup.has(g)) byGroup.set(g, []);
  if (byGroup.get(g)!.length < limit) byGroup.get(g)!.push(s);
}
const streams = [...byGroup.values()].flat();
const pcmCache = new Map<string, Float32Array>();

const results: Record<string, unknown>[] = [];
const quantile = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };

for (const variant of variants) {
  const runner =
    variant === "tracker" ? await trackerRunner(true)
    : variant === "tracker-noprep" ? await trackerRunner(false)
    : variant === "baseline" ? await baselineRunner()
    : variant === "fastconformer" ? await fastConformerRunner()
    : null;
  if (!runner) throw new Error("unknown variant " + variant);
  const agg = new Map<string, { n: number; exp: number; hits: number; wrong: number; conf: number; exact: number; latS: number[]; latE: number[]; ms: number; sec: number; errors: string[] }>();
  for (const s of streams) {
    let pcm = pcmCache.get(s.file);
    if (!pcm) { pcm = loadWav(`${DATA}/${s.file}`); if (pcmCache.size < 400) pcmCache.set(s.file, pcm); }
    const r = await runner(pcm);
    const sc = score(s, r.confirmations);
    const g = `${s.cond}|${s.kind}`;
    if (!agg.has(g)) agg.set(g, { n: 0, exp: 0, hits: 0, wrong: 0, conf: 0, exact: 0, latS: [], latE: [], ms: 0, sec: 0, errors: [] });
    const a = agg.get(g)!;
    a.n++; a.exp += sc.expected; a.hits += sc.hits; a.wrong += sc.wrong; a.conf += sc.confirmed; a.exact += sc.exact ? 1 : 0;
    if (sc.latencyStart != null) { a.latS.push(sc.latencyStart); a.latE.push(sc.latencyEnd!); }
    a.ms += r.computeMs; a.sec += r.audioSec;
    if (!sc.exact) a.errors.push(`${s.id}: expected ${s.expected.map((e) => e.join(":")).join(" ")} | got ${r.confirmations.map((c) => key(c.v) + (c.via ? "(" + ({ continuation: "C", corroborated: "K", discovery: "D", repeat: "R" } as Record<string, string>)[c.via] + ")" : "")).join(" ")}`);
  }
  for (const [g, a] of agg) {
    const [cond, kind] = g.split("|");
    const row = {
      variant, cond, kind, streams: a.n,
      recall: a.exp ? +(a.hits / a.exp).toFixed(4) : null,
      wrong: a.wrong,
      precision: a.conf ? +((a.conf - a.wrong) / a.conf).toFixed(4) : null,
      exact: +(a.exact / a.n).toFixed(4),
      latStartMed: +quantile(a.latS, 0.5).toFixed(2), latEndMed: +quantile(a.latE, 0.5).toFixed(2), latEndP90: +quantile(a.latE, 0.9).toFixed(2),
      rtf: +(a.ms / 1000 / a.sec).toFixed(4),
      errors: a.errors,
    };
    results.push(row);
    console.log(`${variant.padEnd(15)} ${cond!.padEnd(6)} ${kind!.padEnd(8)} n=${String(a.n).padStart(3)} recall=${row.recall ?? "-"} wrong=${a.wrong} prec=${row.precision ?? "-"} exact=${row.exact} lat(start/end med, end p90)=${row.latStartMed}/${row.latEndMed},${row.latEndP90} rtf=${row.rtf}`);
  }
}
if (outFile) writeFileSync(outFile, JSON.stringify({ sets, results }, null, 1));
