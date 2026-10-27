import { parseClipName, TranslationLibrary, UrlLibrary, type ClipSource } from "../core/playback/library";
import type { VerseRef } from "../core/types";
import { getState, notify, setState } from "./store";

/**
 * The user's English translation clips. Imported files are kept on this device in
 * IndexedDB (they never leave the phone); an optional hosted folder can be used too.
 * Device files win over hosted ones; within each source the resolver is exact.
 */
const DB = "ayahlive-library";
const STORE = "clips";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const device = new TranslationLibrary();
let hosted: UrlLibrary | null = null;
let db: IDBDatabase | null = null;
/** Files picked this session that could not be stored (kept in memory instead). */
const memory = new Map<string, Blob>();

function deviceSource(name: string): ClipSource {
  return {
    name,
    load: async () => {
      const m = memory.get(name);
      if (m) return m;
      const d = db ?? (db = await openDb());
      const blob = await req(d.transaction(STORE).objectStore(STORE).get(name));
      if (!(blob instanceof Blob)) throw new Error("missing");
      return blob;
    },
  };
}

function publish(): void {
  const st = device.stats();
  const source = device.size && hosted ? "device+url" : device.size ? "device" : hosted ? "url" : "none";
  setState((s) => ({ library: { ...st, source, importing: s.library.importing, coverage: device.coverage() } }));
}

export async function initLibrary(): Promise<void> {
  try {
    db = await openDb();
    const keys = (await req(db.transaction(STORE).objectStore(STORE).getAllKeys())) as string[];
    device.clear();
    for (const k of keys) device.add(deviceSource(k));
  } catch {
    db = null;
  }
  await setHostedUrl(getState().settings.libraryUrl, false);
  publish();
}

export async function setHostedUrl(url: string, announce = true): Promise<void> {
  hosted = null;
  if (url.trim()) {
    const base = new URL(url.trim(), document.baseURI).href;
    hosted = new UrlLibrary(base);
    const listed = await hosted.init();
    if (announce) notify(listed ? "Hosted translations found (with index.json)." : "Hosted folder set. Files are looked up by name when needed.");
  }
  publish();
}

/** Import picked files (from a folder or a multi-select). Only recognised names are kept. */
export async function importFiles(files: FileList | File[]): Promise<void> {
  const list = [...files].filter((f) => parseClipName(f.webkitRelativePath || f.name).kind !== "other");
  const skipped = files.length - list.length;
  if (!list.length) {
    notify("None of those files are named like 29-11.mp3, 104.mp3, start.mp3 or stop.mp3.", "warn", 8000);
    return;
  }
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }
  setState((s) => ({ library: { ...s.library, importing: { done: 0, total: list.length } } }));
  let stored = 0, inMemory = 0;
  const BATCH = 50;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    try {
      const d = db ?? (db = await openDb());
      const tx = d.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      for (const f of batch) os.put(f.slice(0, f.size, "audio/mpeg"), f.name.toLowerCase());
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      stored += batch.length;
    } catch {
      for (const f of batch) memory.set(f.name.toLowerCase(), f);
      inMemory += batch.length;
    }
    for (const f of batch) device.add(deviceSource(f.name.toLowerCase()));
    setState((s) => ({ library: { ...s.library, importing: { done: Math.min(list.length, i + BATCH), total: list.length } } }));
  }
  setState((s) => ({ library: { ...s.library, importing: null } }));
  publish();
  const st = device.stats();
  const n = (k: number, one: string, many: string) => `${k.toLocaleString()} ${k === 1 ? one : many}`;
  let msg = `Added ${n(list.length, "file", "files")}. Available now: ${n(st.ayahFiles, "verse translation", "verse translations")} and ${n(st.surahFiles, "whole-surah file", "whole-surah files")}.`;
  if (inMemory) msg += ` ${n(inMemory, "file", "files")} could not be saved on this device and will need adding again next time.`;
  if (skipped) msg += ` Ignored ${n(skipped, "file", "files")} with other names.`;
  void stored;
  notify(msg, inMemory ? "warn" : "info", 9000);
}

export async function clearLibrary(): Promise<void> {
  memory.clear();
  device.clear();
  try {
    const d = db ?? (db = await openDb());
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await new Promise<void>((r) => (tx.oncomplete = () => r()));
  } catch {
    /* ignore */
  }
  publish();
}

/** Exact lookup for one verse: device first, then hosted. Never another verse. */
export async function resolveAyahClip(v: VerseRef): Promise<Blob | string | null> {
  const d = device.resolveAyah(v);
  if (d) {
    try {
      return await d.load();
    } catch {
      /* fall through to hosted copy of the same verse */
    }
  }
  return hosted ? hosted.resolveAyah(v) : null;
}

export async function resolveSurahClip(s: number): Promise<Blob | string | null> {
  const d = device.resolveSurah(s);
  if (d) {
    try {
      return await d.load();
    } catch {
      /* hosted */
    }
  }
  return hosted ? hosted.resolveSurah(s) : null;
}

export async function resolveCue(c: "start" | "stop"): Promise<Blob | string | null> {
  const d = device.resolveCue(c);
  if (d) {
    try {
      return await d.load();
    } catch {
      /* default */
    }
  }
  return null;
}

/** Ayahs of surah s with a verse file on this device. */
export function deviceAyahs(s: number): number[] {
  return device.ayahsOf(s);
}

/** A hosted folder is set (its contents can't be listed, only looked up). */
export function hasHosted(): boolean {
  return !!hosted;
}

export function hasSurahClip(s: number): boolean {
  return !!device.resolveSurah(s) || !!hosted;
}
