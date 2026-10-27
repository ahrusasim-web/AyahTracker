import { useEffect, useState } from "react";
import type { VerseRef } from "../core/types";

/**
 * Display text for verses (Tanzil Uthmani). The source file is kept verbatim; for display we
 * drop the byte-order mark, the rub' al-hizb sign, and the basmala that this edition prefixes
 * to the first verse of each surah (it is not part of that verse in Hafs numbering, except in
 * Al-Fatihah).
 */
let text: Map<string, string> | null = null;
let loading: Promise<Map<string, string>> | null = null;

const BASMALA = ["بسم", "ٱلله", "ٱلرحمن", "ٱلرحيم"];
const bare = (w: string) => w.replace(/[\u064B-\u065F\u0670\u0640]/g, "");

function dropBasmala(t: string): string {
  const words = t.split(/\s+/);
  if (words.length > 4 && BASMALA.every((b, i) => bare(words[i]!) === b)) return words.slice(4).join(" ");
  return t;
}

async function load(): Promise<Map<string, string>> {
  const url = new URL("models/quran.json", document.baseURI).href;
  let res: Response | undefined;
  try {
    res = await (await caches.open("ayah-live-models-v1")).match(url);
  } catch {
    /* no cache storage */
  }
  if (!res) res = await fetch(url);
  const rows = (await res.json()) as { surah: number; ayah: number; text_uthmani: string }[];
  const m = new Map<string, string>();
  for (const r of rows) {
    let t = r.text_uthmani.replace(/\uFEFF/g, "").replace(/\u06DE\s*/g, "").trim();
    if (r.ayah === 1 && r.surah !== 1 && r.surah !== 9) t = dropBasmala(t);
    m.set(`${r.surah}:${r.ayah}`, t);
  }
  return m;
}

export function useVerseText(v: VerseRef | null): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (text || !v) return;
    loading ??= load().then((m) => (text = m));
    let live = true;
    loading.then(() => live && force((n) => n + 1)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [v]);
  return v && text ? (text.get(`${v.s}:${v.a}`) ?? null) : null;
}
