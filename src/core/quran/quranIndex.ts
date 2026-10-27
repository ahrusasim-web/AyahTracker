import data from "../../data/quran-index.json";

/** A verse location in standard Hafs numbering. */
export interface VerseRef {
  s: number;
  a: number;
}

export const key = (v: VerseRef): string => `${v.s}:${v.a}`;
export const parseKey = (k: string): VerseRef => {
  const [s, a] = k.split(":").map(Number);
  return { s: s!, a: a! };
};
export const sameVerse = (x: VerseRef | null | undefined, y: VerseRef | null | undefined): boolean =>
  !!x && !!y && x.s === y.s && x.a === y.a;

export interface SurahInfo {
  n: number;
  name: string;
  nameEn: string;
  ayahs: number;
}

interface IndexData {
  surahs: SurahInfo[];
  words: number[][];
  identical: string[][];
  prefixTwins: string[];
  nearTwins: string[];
  checksums: Record<string, string>;
}

/**
 * Static facts about the canonical text that the tracker needs: verse counts, the
 * recogniser's word counts, and which verses are textually identical or confusable.
 * Built and verified against the Hafs counts by scripts/build-data.mjs.
 */
export class QuranIndex {
  readonly surahs: SurahInfo[];
  readonly checksums: Record<string, string>;
  private readonly wordCounts: number[][];
  private readonly groupOf = new Map<string, VerseRef[]>();
  private readonly prefixTwinSet: Set<string>;
  private readonly nearTwinSet: Set<string>;

  constructor(d: IndexData = data as IndexData) {
    this.surahs = d.surahs;
    this.checksums = d.checksums;
    this.wordCounts = d.words;
    for (const g of d.identical) {
      const refs = g.map(parseKey);
      for (const k of g) this.groupOf.set(k, refs);
    }
    this.prefixTwinSet = new Set(d.prefixTwins);
    this.nearTwinSet = new Set(d.nearTwins);
  }

  get verseCount(): number {
    return this.surahs.reduce((n, s) => n + s.ayahs, 0);
  }

  isValid(v: VerseRef): boolean {
    return Number.isInteger(v.s) && Number.isInteger(v.a) && v.s >= 1 && v.s <= 114 && v.a >= 1 && v.a <= this.surahs[v.s - 1]!.ayahs;
  }

  ayahCount(s: number): number {
    return this.surahs[s - 1]?.ayahs ?? 0;
  }

  surah(s: number): SurahInfo | undefined {
    return this.surahs[s - 1];
  }

  words(v: VerseRef): number {
    return this.wordCounts[v.s - 1]?.[v.a - 1] ?? 0;
  }

  /** Every location whose normalised text is identical to v's (including v), or [v]. */
  identicalGroup(v: VerseRef): VerseRef[] {
    return this.groupOf.get(key(v)) ?? [v];
  }

  hasIdenticalTwin(v: VerseRef): boolean {
    return this.groupOf.has(key(v));
  }

  /** The first half of v (where the recogniser's 50% gate fires) also opens another verse. */
  isPrefixTwin(v: VerseRef): boolean {
    return this.prefixTwinSet.has(key(v));
  }

  /** v is at least 75% word-identical to a different verse. */
  isNearTwin(v: VerseRef): boolean {
    return this.nearTwinSet.has(key(v));
  }

  isLastAyah(v: VerseRef): boolean {
    return v.a === this.ayahCount(v.s);
  }

  next(v: VerseRef): VerseRef | null {
    return v.a < this.ayahCount(v.s) ? { s: v.s, a: v.a + 1 } : null;
  }
}

export const quranIndex = new QuranIndex();
