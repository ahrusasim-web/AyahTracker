#!/usr/bin/env node
/**
 * Build the app's verse index from the canonical text sources and verify them.
 *
 * Inputs (downloaded by scripts/fetch-assets.mjs into public/models/):
 *   quran.json            Tanzil Uthmani text (via Tilawa release v0.2.0), 6,236 verses
 *   zipformer_quran.json  Tilawa phoneme corpus (word segmentation the recogniser uses)
 *
 * Output: src/data/quran-index.json
 *   surahs        number, Arabic + English name, ayah count
 *   words         per-surah arrays of per-ayah word counts (the recogniser's word units)
 *   identical     groups of verses whose normalised text is identical (e.g. 55:13 ×31)
 *   prefixTwins   verses whose first half (the recogniser's 50% gate) also opens another verse
 *   nearTwins     verses ≥75% word-identical to a different verse
 *   checksums     SHA-256 of the two source files, so the app can verify what it loaded
 *
 * Fails loudly if the verse counts differ from the standard Hafs (Kufan) count.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = process.argv[2] ?? resolve(root, "public/models");
const quranRaw = readFileSync(resolve(modelsDir, "quran.json"));
const corpusRaw = readFileSync(resolve(modelsDir, "zipformer_quran.json"));
const quran = JSON.parse(quranRaw.toString("utf8"));
const corpus = JSON.parse(corpusRaw.toString("utf8"));

// Standard Hafs 'an 'Asim (Kufan) verse counts, surahs 1..114. Sum = 6,236.
const HAFS = [7,286,200,176,120,165,206,75,129,109,123,111,43,52,99,128,111,110,98,135,112,78,118,64,77,227,93,88,69,60,34,30,73,54,45,83,182,88,75,85,54,53,89,59,37,35,38,29,18,45,60,49,62,55,78,96,29,22,24,13,14,11,11,18,12,12,30,52,52,44,28,28,20,56,40,31,50,40,46,42,29,19,36,25,22,17,19,26,30,20,15,21,11,8,8,19,5,8,8,11,11,8,3,9,5,4,7,3,6,3,5,4,5,6];

function fail(msg) { console.error("build-data: " + msg); process.exit(1); }
if (HAFS.reduce((a, b) => a + b, 0) !== 6236) fail("internal Hafs table broken");
if (quran.length !== 6236) fail(`quran.json has ${quran.length} verses, expected 6236`);
if (corpus.surahs.length !== 114) fail("corpus must have 114 surahs");
const seen = new Set();
for (const v of quran) {
  const k = `${v.surah}:${v.ayah}`;
  if (seen.has(k)) fail("duplicate verse " + k);
  seen.add(k);
  if (v.ayah < 1 || v.ayah > HAFS[v.surah - 1]) fail("out-of-range verse " + k);
}
corpus.surahs.forEach((s, i) => {
  if (s.n !== i + 1) fail("corpus surah order");
  if (s.ayahs.length !== HAFS[i]) fail(`corpus surah ${s.n} has ${s.ayahs.length} ayahs, Hafs has ${HAFS[i]}`);
});

export function normalizeArabic(s) {
  return s
    .replace(/[\uFEFF\u200F\u200E\u200B]/g, "")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "") // harakat, dagger alif, Quranic marks, tatweel
    .replace(/[\u0671\u0622\u0623\u0625]/g, "ا") // alef forms -> bare alef
    .replace(/\u0649/g, "ي") // alef maksura -> ya
    .replace(/\u0629/g, "ه") // ta marbuta -> ha
    .replace(/\u0624/g, "و") // waw with hamza -> waw
    .replace(/\u0626/g, "ي") // ya with hamza -> ya
    .replace(/[\u06DE\u06E9]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


const verses = []; // {s,a,words:[normalised]}
const words = corpus.surahs.map((s) => s.ayahs.map((a) => a.w.length));
for (const s of corpus.surahs) {
  for (const a of s.ayahs) {
    verses.push({ s: s.n, a: a.n, w: a.w.map((x) => normalizeArabic(x[2])).filter(Boolean) });
  }
}

// Identical groups
const byText = new Map();
for (const v of verses) {
  const t = v.w.join(" ");
  if (!byText.has(t)) byText.set(t, []);
  byText.get(t).push(`${v.s}:${v.a}`);
}
const identical = [...byText.values()].filter((g) => g.length > 1);

// Prefix twins at the recogniser's 50% gate
const prefixCount = new Map();
for (const v of verses) {
  for (let k = 1; k <= Math.min(v.w.length, 60); k++) {
    const p = v.w.slice(0, k).join(" ");
    prefixCount.set(p, (prefixCount.get(p) ?? 0) + 1);
  }
}
const identicalSet = new Set(identical.flat());
const prefixTwins = [];
for (const v of verses) {
  const k = Math.max(1, Math.ceil(v.w.length / 2));
  const p = v.w.slice(0, Math.min(k, 60)).join(" ");
  const n = prefixCount.get(p) ?? 0;
  if (n > 1 && !identicalSet.has(`${v.s}:${v.a}`)) prefixTwins.push(`${v.s}:${v.a}`);
}

// Near twins (word-level Levenshtein similarity >= 0.75), candidates via shared word bigrams
function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const bigramIdx = new Map();
verses.forEach((v, i) => {
  const seenB = new Set();
  for (let j = 0; j + 1 < v.w.length; j++) {
    const b = v.w[j] + " " + v.w[j + 1];
    if (seenB.has(b)) continue;
    seenB.add(b);
    if (!bigramIdx.has(b)) bigramIdx.set(b, []);
    bigramIdx.get(b).push(i);
  }
});
const nearTwins = new Set();
verses.forEach((v, i) => {
  if (v.w.length < 3) return;
  const counts = new Map();
  for (let j = 0; j + 1 < v.w.length; j++) {
    const lst = bigramIdx.get(v.w[j] + " " + v.w[j + 1]);
    if (!lst || lst.length > 400) continue;
    for (const o of lst) if (o !== i) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  for (const [o, c] of counts) {
    if (c < Math.max(1, (v.w.length - 1) * 0.5)) continue;
    const w = verses[o].w;
    if (w.join(" ") === v.w.join(" ")) continue;
    const sim = 1 - lev(v.w, w) / Math.max(v.w.length, w.length);
    if (sim >= 0.75) { nearTwins.add(`${v.s}:${v.a}`); break; }
  }
});

const sha = (b) => createHash("sha256").update(b).digest("hex");
const out = {
  version: 1,
  source: { text: "Tanzil Uthmani (CC-BY-3.0) via Tilawa release v0.2.0", segmentation: "Tilawa zipformer_quran.json v0.3.0" },
  checksums: { "quran.json": sha(quranRaw), "zipformer_quran.json": sha(corpusRaw) },
  surahs: corpus.surahs.map((s, i) => ({ n: s.n, name: s.name, nameEn: s.nameEn, ayahs: HAFS[i] })),
  words,
  identical,
  prefixTwins,
  nearTwins: [...nearTwins],
};
const dest = resolve(root, "src/data/quran-index.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out));
console.log(`build-data: 114 surahs / 6236 verses verified against Hafs counts; ${identical.length} identical groups (${identical.flat().length} verses), ${prefixTwins.length} prefix twins, ${nearTwins.size} near twins -> ${dest}`);
