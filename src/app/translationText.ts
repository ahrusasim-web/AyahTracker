import { useEffect, useState } from "react";
import { quranIndex } from "../core/quran/quranIndex";
import { cleanApiText, findHaleem, parseTranslationFile } from "../core/text/translationText";
import { notify } from "./store";

/**
 * English translation text for passage summaries: M.A.S. Abdel Haleem's translation, fetched
 * per surah from Quran.com's public API the first time it's needed and cached on the phone
 * (so summaries work offline afterwards). A translation file the user imports takes priority.
 */
const API = "https://api.quran.com/api/v4";
const DB = "ayahlive-text";
const STORE = "surahs";
const ID_KEY = "ayahlive.haleemId";
export const ATTRIBUTION = "M.A.S. Abdel Haleem, The Qur'an: A New Translation (Oxford University Press), via Quran.com";

interface SurahText {
  verses: string[];
  source: "qurancom" | "import";
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function getStored(k: string): Promise<SurahText | undefined> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const r = d.transaction(STORE).objectStore(STORE).get(k);
      r.onsuccess = () => resolve(r.result as SurahText | undefined);
      r.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

async function putStored(k: string, v: SurahText): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* no persistent cache: still works online */
  }
}

async function haleemId(): Promise<number> {
  const cached = Number(localStorage.getItem(ID_KEY));
  if (cached > 0) return cached;
  const res = await fetch(`${API}/resources/translations`);
  if (!res.ok) throw new Error(`Quran.com answered ${res.status}`);
  const found = findHaleem(await res.json());
  if (!found) throw new Error("Abdel Haleem's translation isn't listed by Quran.com");
  try {
    localStorage.setItem(ID_KEY, String(found.id));
  } catch {
    /* ignore */
  }
  return found.id;
}

const inflight = new Map<number, Promise<SurahText>>();

async function fetchSurah(s: number): Promise<SurahText> {
  const id = await haleemId();
  const res = await fetch(`${API}/quran/translations/${id}?chapter_number=${s}`);
  if (!res.ok) throw new Error(`Quran.com answered ${res.status}`);
  const body = (await res.json()) as { translations?: { text?: string }[] };
  const verses = (body.translations ?? []).map((t) => cleanApiText(t.text ?? ""));
  if (verses.length !== quranIndex.ayahCount(s)) throw new Error("Quran.com returned an incomplete surah");
  const v: SurahText = { verses, source: "qurancom" };
  await putStored(`q:${s}`, v);
  return v;
}

async function surahText(s: number): Promise<SurahText> {
  const imported = await getStored(`i:${s}`);
  if (imported && imported.verses.some(Boolean)) return imported;
  const cached = await getStored(`q:${s}`);
  if (cached) return cached;
  let p = inflight.get(s);
  if (!p) {
    p = fetchSurah(s).finally(() => inflight.delete(s));
    inflight.set(s, p);
  }
  return p;
}

export type PassageText = { status: "loading" } | { status: "ready"; verses: { a: number; text: string }[]; source: "qurancom" | "import" } | { status: "error"; message: string };

export async function passageText(s: number, from: number, to: number): Promise<PassageText> {
  try {
    const t = await surahText(s);
    const verses = [];
    for (let a = from; a <= to; a++) verses.push({ a, text: t.verses[a - 1] ?? "" });
    if (verses.some((v) => !v.text)) return { status: "error", message: "Some verses are missing from the translation text." };
    return { status: "ready", verses, source: t.source };
  } catch (e) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return {
      status: "error",
      message: offline
        ? "No connection. The translation text will appear the next time you're online."
        : "Couldn't load Abdel Haleem's translation from Quran.com. You can import a translation file in Settings.",
    };
  }
}

/** Start fetching a surah's text early (when a passage begins), so the summary is ready. */
export function prefetchSurah(s: number): void {
  void surahText(s).catch(() => undefined);
}

export function usePassageText(s: number, from: number, to: number, enabled = true): PassageText {
  const [state, setState] = useState<PassageText>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState({ status: "loading" });
    void passageText(s, from, to).then((r) => live && setState(r));
    return () => {
      live = false;
    };
  }, [s, from, to, enabled]);
  return state;
}

/** Download every surah's text for offline use. */
export async function downloadAllText(onProgress: (done: number) => void): Promise<number> {
  let ok = 0;
  for (let s = 1; s <= 114; s++) {
    try {
      await surahText(s);
      ok++;
    } catch {
      /* keep going */
    }
    onProgress(s);
  }
  return ok;
}

/** Import a translation file (JSON or "surah|ayah|text" lines); it replaces Quran.com text. */
export async function importTranslationFile(file: File): Promise<void> {
  const map = parseTranslationFile(await file.text());
  if (map.size < 100) {
    notify("That file doesn't look like a translation (expected lines like 1|1|In the name of God…).", "warn", 8000);
    return;
  }
  for (let s = 1; s <= 114; s++) {
    const verses = Array.from({ length: quranIndex.ayahCount(s) }, (_, i) => map.get(`${s}:${i + 1}`) ?? "");
    if (verses.some(Boolean)) await putStored(`i:${s}`, { verses, source: "import" });
  }
  notify(`Imported translation text for ${map.size.toLocaleString()} verses.`, "info", 6000);
}
