// Smoke test: stream one audio file through the Tilawa Zipformer session and print events.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as ort from "onnxruntime-node";
import { createZipformerSession } from "@tilawa/core";

const A = new URL("../assets-dl/", import.meta.url).pathname;
const file = process.argv[2];

function decode(path) {
  const buf = execFileSync("ffmpeg", ["-v", "quiet", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
}

const t0 = performance.now();
const session = await createZipformerSession({
  ort,
  model: () => readFileSync(A + "zipformer_a0w_ep1_a05.int8.onnx"),
  corpus: () => JSON.parse(readFileSync(A + "zipformer_quran.json", "utf8")),
  quran: () => JSON.parse(readFileSync(A + "quran.json", "utf8")),
  debug: true,
});
console.log("load ms", Math.round(performance.now() - t0));

const pcm = decode(file);
const CH = 5120; // 320 ms
let compute = 0;
for (let i = 0; i < pcm.length; i += CH) {
  const t = performance.now();
  const msgs = await session.feed(pcm.subarray(i, i + CH));
  compute += performance.now() - t;
  const at = ((i + CH) / 16000).toFixed(2);
  for (const m of msgs) {
    if (m.type === "raw_transcript") continue;
    if (m.type === "word_progress") { console.log(at, "progress", `${m.surah}:${m.ayah}`, `${m.word_index}/${m.total_words}`); continue; }
    if (m.type === "verse_match") { console.log(at, "MATCH", `${m.surah}:${m.ayah}`, m.confidence); continue; }
    if (m.type === "debug") { console.log(at, "debug", m.event, JSON.stringify(m.data)); continue; }
    console.log(at, m.type, JSON.stringify(m).slice(0, 200));
  }
}
const fin = await session.stop();
for (const m of fin) if (m.type !== "raw_transcript") console.log("stop", m.type, JSON.stringify(m).slice(0, 300));
console.log("audio s", (pcm.length / 16000).toFixed(1), "compute s", (compute / 1000).toFixed(2), "RTF", (compute / 1000 / (pcm.length / 16000)).toFixed(3));
