import type { VerseRef } from "../quran/quranIndex";

export type PrayerContext = "general" | "jummah" | "maghrib" | "isha";

/**
 * Soft priors for prayer contexts.
 *
 * These are NOT frequency distributions. They are small multipliers on how readily the
 * tracker accepts a *new* location (a discovery) without waiting for corroboration.
 * Nothing here ever prevents any verse of the 114 surahs from being identified; an
 * unfavoured location only needs one more piece of audio evidence before it is confirmed.
 *
 * Evidence used (reported practice, not statistics):
 *  - Jumu'ah: Al-A'la (87) and Al-Ghashiyah (88) — Sahih Muslim 878 (Nu'man b. Bashir);
 *    Al-Jumu'ah (62) and Al-Munafiqun (63) — Sahih Muslim 877.
 *  - Maghrib: short mufassal surahs — Sunan an-Nasa'i 983 (Sulayman b. Yasar from Abu Hurayrah,
 *    graded sahih); At-Tur (52) — Sahih al-Bukhari 765; Al-Mursalat (77) — Sahih al-Bukhari 763.
 *  - Isha: medium mufassal — Sunan an-Nasa'i 982/983 (Ash-Shams and similar); At-Tin (95) —
 *    Sahih al-Bukhari 767; the Mu'adh narrations name Al-A'la, Ash-Shams, Al-Layl and similar.
 *  - Every rak'ah begins with Al-Fatihah.
 * Mufassal bands follow one common division (scholars differ on the exact boundaries):
 *  long 50–77, medium 78–92, short 93–114.
 */
export interface PriorProfile {
  /** Prior weight for a surah: 1 = neutral, >1 = favoured. */
  weight(s: number): number;
  /** Whether a long pause in this context means a new rak'ah (expect Al-Fatihah). */
  expectsFatihahAfterLongPause: boolean;
  label: string;
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function profile(label: string, named: number[], band: number[], fatihah: boolean): PriorProfile {
  const n = new Set(named);
  const b = new Set(band);
  return {
    label,
    expectsFatihahAfterLongPause: fatihah,
    weight: (s) => (s === 1 && fatihah ? 3 : n.has(s) ? 3 : b.has(s) ? 2 : 1),
  };
}

export const PRIORS: Record<PrayerContext, PriorProfile> = {
  general: { label: "General", expectsFatihahAfterLongPause: false, weight: () => 1 },
  jummah: profile("Jummah", [62, 63, 87, 88], [], true),
  maghrib: profile("Maghrib", [52, 77], range(93, 114), true),
  isha: profile("Isha", [87, 91, 92, 95], range(78, 92), true),
};

export function priorWeight(ctx: PrayerContext, v: VerseRef): number {
  return PRIORS[ctx].weight(v.s);
}
