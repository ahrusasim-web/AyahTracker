#!/usr/bin/env node
/**
 * Downloads the recogniser and canonical text into public/models/, verified by SHA-256.
 * Run once after `npm install`; the GitHub Pages workflow runs it on every build.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const R = "https://github.com/yazinsai/tilawa/releases/download";
const ASSETS = [
  { file: "zipformer_a0w_ep1_a05.int8.onnx", url: `${R}/zipformer-a0w-ep1-a0.5/zipformer_a0w_ep1_a05.int8.onnx`, sha256: "bfb5b712695634a6099b45a6a78003bd5103417c4eae6338277d54679254905a" },
  { file: "zipformer_quran.json", url: `${R}/v0.3.0/zipformer_quran.json`, sha256: "24360c05ec88fcacf3419c1fe6cd81d69e653326a0bf0e4fb507e7b98fc88127" },
  { file: "quran.json", url: `${R}/v0.2.0/quran.json`, sha256: "6e6f31f642c701b49a1ba090311ca4c7a97c6a5b79a302712dff815a9d7b3d03" },
  { file: "NPL-1.2.txt", url: `${R}/zipformer-a0w-ep1-a0.5/NPL-1.2.txt`, sha256: "77526bdbfac94132e5114c3a34492c33f915e4b7f310f00b9995500d3610cab5" },
];

const sha = (b) => createHash("sha256").update(b).digest("hex");
const models = resolve(root, "public/models");
mkdirSync(models, { recursive: true });

for (const a of ASSETS) {
  const dest = resolve(models, a.file);
  if (existsSync(dest) && sha(readFileSync(dest)) === a.sha256) {
    console.log(`ok      ${a.file}`);
    continue;
  }
  let buf = null;
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    const res = await fetch(a.url, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`retry   ${a.file} (HTTP ${res.status})`);
      continue;
    }
    const b = Buffer.from(await res.arrayBuffer());
    if (sha(b) === a.sha256) buf = b;
    else console.warn(`retry   ${a.file} (checksum mismatch)`);
  }
  if (!buf) {
    console.error(`failed  ${a.file} from ${a.url}`);
    process.exit(1);
  }
  writeFileSync(dest, buf);
  console.log(`fetched ${a.file} (${(buf.length / 1048576).toFixed(1)} MB)`);
}
