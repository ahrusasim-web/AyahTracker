/**
 * Verse-level latency: how long after a verse's Arabic audio begins is it confirmed?
 *
 * Uses the salah streams: their passages are EveryAyah recordings, which have short silences
 * between verses, so verse start times can be read off the clean audio's energy envelope.
 * Passages whose silence count doesn't match their verse count are skipped.
 *
 *   npx tsx bench/latency.ts --data <corpus-dir> [--conds clean,hall] [--limit 12]
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as ort from "onnxruntime-node";
import { TilawaRecognizer } from "../src/core/engine/recognizer";
import { RecognitionPipeline } from "../src/core/pipeline";

const args = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const DATA = arg("data")!;
const conds = arg("conds", "clean,hall")!.split(",");
const limit = Number(arg("limit", "12"));
const M = new URL("../public/models/", import.meta.url).pathname;

interface Stream { id: string; cond: string; kind: string; file: string; expected: number[][]; segments: [number, number][] }
const manifest: { streams: Stream[] } = JSON.parse(readFileSync(`${DATA}/manifest.json`, "utf8"));

function load(path: string): Float32Array {
  const buf = execFileSync("ffmpeg", ["-v", "quiet", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

/** Speech-run start times (s) inside [t0, t1], splitting on silences of at least minGap seconds. */
function verseStarts(pcm: Float32Array, t0: number, t1: number, minGap = 0.28): number[] {
  const F = 320;
  const e: number[] = [];
  for (let i = Math.floor(t0 * 16000); i + F <= Math.min(pcm.length, t1 * 16000); i += F) {
    let s = 0;
    for (let k = 0; k < F; k++) s += pcm[i + k]! * pcm[i + k]!;
    e.push(10 * Math.log10(s / F + 1e-12));
  }
  const sorted = [...e].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)]!;
  const thr = loud - 32;
  const starts: number[] = [];
  let silentRun = Infinity;
  for (let j = 0; j < e.length; j++) {
    if (e[j]! < thr) silentRun++;
    else {
      if (silentRun * 0.02 >= minGap) starts.push(t0 + j * 0.02);
      silentRun = 0;
    }
  }
  return starts;
}

const rec = await TilawaRecognizer.create({ ort, model: readFileSync(M + "zipformer_a0w_ep1_a05.int8.onnx"), corpus: JSON.parse(readFileSync(M + "zipformer_quran.json", "utf8")) });
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN; };

for (const cond of conds) {
  const streams = manifest.streams.filter((s) => s.kind === "salah" && s.cond === cond).slice(0, limit);
  const firstLat: number[] = [], nextLat: number[] = [];
  let verses = 0, confirmed = 0, passagesUsed = 0, passagesSkipped = 0;
  for (const st of streams) {
    const clean = manifest.streams.find((x) => x.cond === "clean" && x.kind === "salah" && x.id.split(":").slice(2).join(":") === st.id.split(":").slice(2).join(":"))!;
    const cleanPcm = load(`${DATA}/${clean.file}`);
    // expected verses per passage, in order
    const passages: { s: number; ayahs: number[]; starts: number[] }[] = [];
    let k = 0;
    for (const seg of st.segments) {
      const first = st.expected[k]!;
      const ayahs: number[] = [];
      while (k < st.expected.length && st.expected[k]![0] === first[0] && (ayahs.length === 0 || st.expected[k]![1] === ayahs[ayahs.length - 1]! + 1)) ayahs.push(st.expected[k++]![1]!);
      const starts = verseStarts(cleanPcm, seg[0], seg[1]);
      passages.push({ s: first[0]!, ayahs, starts });
    }
    const pcm = load(`${DATA}/${st.file}`);
    const pipe = new RecognitionPipeline(rec, {});
    pipe.restart();
    const conf: { s: number; a: number; t: number }[] = [];
    for (let i = 0; i < pcm.length; i += 5120) {
      for (const e of await pipe.push(pcm.subarray(i, i + 5120))) if (e.type === "confirmed") conf.push({ s: e.entry.v.s, a: e.entry.v.a, t: e.entry.t });
    }
    for (const p of passages) {
      if (p.starts.length !== p.ayahs.length) { passagesSkipped++; continue; }
      passagesUsed++;
      p.ayahs.forEach((a, i) => {
        verses++;
        const start = p.starts[i]!;
        const end = i + 1 < p.starts.length ? p.starts[i + 1]! : start + 30;
        const c = conf.find((x) => x.s === p.s && x.a === a && x.t >= start - 0.5 && x.t <= end + 60);
        if (!c) return;
        confirmed++;
        (i === 0 ? firstLat : nextLat).push(c.t - start);
      });
    }
  }
  console.log(
    `${cond.padEnd(6)} passages ${passagesUsed} (skipped ${passagesSkipped}) verses ${verses} confirmed ${confirmed} | ` +
      `next-verse latency from its start: median ${quantile(nextLat, 0.5).toFixed(2)} s, p90 ${quantile(nextLat, 0.9).toFixed(2)} s | ` +
      `first verse of passage: median ${quantile(firstLat, 0.5).toFixed(2)} s, p90 ${quantile(firstLat, 0.9).toFixed(2)} s`,
  );
}
