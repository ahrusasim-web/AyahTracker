import { quranIndex, type VerseRef } from "../quran/quranIndex";

/** Where a translation clip's bytes come from: a stored Blob, or a URL. */
export interface ClipSource {
  name: string;
  load(): Promise<Blob | string>;
}

export type ParsedName = { kind: "ayah"; s: number; a: number } | { kind: "surah"; s: number } | { kind: "cue"; cue: "start" | "stop" } | { kind: "other" };

/**
 * Parse a translation file name. Accepted, case-insensitively:
 *   "{surah}-{ayah}.mp3"  with or without zero padding: 92-2.mp3, 92-02.mp3, 114-06.mp3, 092-002.mp3
 *   "{surah}.mp3"         whole-surah translation: 104.mp3, 004.mp3
 *   "start.mp3" / "stop.mp3"  listening cues
 * Anything else, or numbers outside the Hafs verse range, is ignored.
 */
export function parseClipName(path: string): ParsedName {
  const base = path.split(/[\\/]/).pop()!.trim().toLowerCase();
  let m = /^0*(\d{1,3})-0*(\d{1,3})\.mp3$/.exec(base);
  if (m) {
    const s = Number(m[1]), a = Number(m[2]);
    return quranIndex.isValid({ s, a }) ? { kind: "ayah", s, a } : { kind: "other" };
  }
  m = /^0*(\d{1,3})\.mp3$/.exec(base);
  if (m) {
    const s = Number(m[1]);
    return s >= 1 && s <= 114 ? { kind: "surah", s } : { kind: "other" };
  }
  if (base === "start.mp3") return { kind: "cue", cue: "start" };
  if (base === "stop.mp3") return { kind: "cue", cue: "stop" };
  return { kind: "other" };
}

/** Deterministic preference between two names for the same verse: the unpadded form, then the shorter, then alphabetical. */
function preferName(a: string, b: string, canonical: string): string {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la === canonical) return a;
  if (lb === canonical) return b;
  if (la.length !== lb.length) return la.length < lb.length ? a : b;
  return la < lb ? a : b;
}

export interface LibraryStats {
  ayahFiles: number;
  surahFiles: number;
  /** Verses with no translation file. */
  missingAyahs: number;
  /** Names that map to a verse already covered by a preferred name. */
  duplicates: string[];
  ignored: number;
  cues: ("start" | "stop")[];
}

/**
 * Exact file resolver. A verse resolves only to a file named for that verse; there is no
 * fallback to any other ayah or surah under any circumstances.
 */
export class TranslationLibrary {
  private ayah = new Map<string, ClipSource>();
  private surah = new Map<number, ClipSource>();
  private cue = new Map<"start" | "stop", ClipSource>();
  private dup: string[] = [];
  private ignoredCount = 0;

  add(src: ClipSource): ParsedName {
    const p = parseClipName(src.name);
    const base = src.name.split(/[\\/]/).pop()!;
    if (p.kind === "ayah") {
      const k = `${p.s}:${p.a}`;
      const prev = this.ayah.get(k);
      if (prev) {
        const prevBase = prev.name.split(/[\\/]/).pop()!;
        const keep = preferName(prevBase, base, `${p.s}-${p.a}.mp3`);
        if (keep === base) {
          this.dup.push(prevBase);
          this.ayah.set(k, src);
        } else this.dup.push(base);
      } else this.ayah.set(k, src);
    } else if (p.kind === "surah") {
      const prev = this.surah.get(p.s);
      if (prev) {
        const keep = preferName(prev.name.split(/[\\/]/).pop()!, base, `${p.s}.mp3`);
        if (keep === base) {
          this.dup.push(prev.name);
          this.surah.set(p.s, src);
        } else this.dup.push(base);
      } else this.surah.set(p.s, src);
    } else if (p.kind === "cue") {
      this.cue.set(p.cue, src);
    } else this.ignoredCount++;
    return p;
  }

  clear(): void {
    this.ayah.clear();
    this.surah.clear();
    this.cue.clear();
    this.dup = [];
    this.ignoredCount = 0;
  }

  resolveAyah(v: VerseRef): ClipSource | null {
    return this.ayah.get(`${v.s}:${v.a}`) ?? null;
  }

  resolveSurah(s: number): ClipSource | null {
    return this.surah.get(s) ?? null;
  }

  resolveCue(c: "start" | "stop"): ClipSource | null {
    return this.cue.get(c) ?? null;
  }

  get size(): number {
    return this.ayah.size + this.surah.size;
  }

  stats(): LibraryStats {
    return {
      ayahFiles: this.ayah.size,
      surahFiles: this.surah.size,
      missingAyahs: quranIndex.verseCount - this.ayah.size,
      duplicates: [...this.dup],
      ignored: this.ignoredCount,
      cues: [...this.cue.keys()],
    };
  }
}

/**
 * A library hosted at a URL (e.g. a "translations/" folder deployed with the app).
 * Without a directory listing it probes the accepted names for one verse, in a fixed order,
 * and caches the answer. Optional `index.json` (an array of file names) skips probing.
 */
export class UrlLibrary {
  private cache = new Map<string, string | null>();
  private listed: TranslationLibrary | null = null;
  constructor(readonly base: string, private readonly fetcher: typeof fetch = fetch) {}

  private url(name: string): string {
    return this.base.replace(/\/?$/, "/") + name;
  }

  async init(): Promise<boolean> {
    try {
      const r = await this.fetcher(this.url("index.json"), { cache: "no-cache" });
      if (!r.ok) return false;
      const names: unknown = await r.json();
      if (!Array.isArray(names)) return false;
      const lib = new TranslationLibrary();
      for (const n of names) if (typeof n === "string") lib.add({ name: n, load: async () => this.url(n) });
      this.listed = lib;
      return true;
    } catch {
      return false;
    }
  }

  private async probe(names: string[]): Promise<string | null> {
    for (const n of names) {
      if (this.cache.has(n)) {
        const c = this.cache.get(n)!;
        if (c) return c;
        continue;
      }
      try {
        const r = await this.fetcher(this.url(n), { method: "HEAD" });
        const ok = r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
        this.cache.set(n, ok ? this.url(n) : null);
        if (ok) return this.url(n);
      } catch {
        this.cache.set(n, null);
      }
    }
    return null;
  }

  async resolveAyah(v: VerseRef): Promise<string | null> {
    if (this.listed) {
      const s = this.listed.resolveAyah(v);
      return s ? ((await s.load()) as string) : null;
    }
    const p2 = String(v.a).padStart(2, "0"), p3 = String(v.a).padStart(3, "0");
    return this.probe([...new Set([`${v.s}-${v.a}.mp3`, `${v.s}-${p2}.mp3`, `${v.s}-${p3}.mp3`])]);
  }

  async resolveSurah(s: number): Promise<string | null> {
    if (this.listed) {
      const c = this.listed.resolveSurah(s);
      return c ? ((await c.load()) as string) : null;
    }
    return this.probe([...new Set([`${s}.mp3`, `${String(s).padStart(3, "0")}.mp3`])]);
  }
}
