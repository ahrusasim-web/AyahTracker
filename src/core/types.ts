import type { VerseRef } from "./quran/quranIndex";
import type { PrayerContext } from "./tracker/priors";

export type { VerseRef, PrayerContext };

/** How readily a newly discovered location is accepted without corroborating audio. */
export type Sensitivity = "careful" | "balanced" | "fast";

/** Per-word acoustic evidence for one verse, as aligned by the recogniser. */
export interface WordEvidence {
  /** Words aligned with a close match (state ok/unsure). */
  heard: number;
  /** Heard words that are also acoustically confident: low distance and a clear CTC margin. */
  strong: number;
  /** Words aligned but contradicted by what was heard. */
  wrong: number;
  /** The verse's first word is (mostly) heard, closely and confidently. */
  first?: boolean;
}

/**
 * Model-agnostic observations the recogniser produces. The tracker only sees these, so the
 * acoustic model can be swapped without touching the sequence/confidence logic.
 */
export type Observation =
  /** Recogniser's word-level cursor inside a verse: which words have been heard so far. */
  | { kind: "progress"; t: number; v: VerseRef; wordIndex: number; totalWords: number; matched: number[]; evidence?: WordEvidence }
  /** Recogniser's own gate passed for a verse (≥ half its words heard and aligned). */
  | { kind: "match"; t: number; v: VerseRef; confidence: number; evidence?: WordEvidence }
  /** Recogniser locked onto a location from a search (discovery). */
  | { kind: "located"; t: number; v: VerseRef }
  | { kind: "relocated"; t: number; to: VerseRef }
  | { kind: "lost"; t: number }
  /** New recitation tokens were heard. */
  | { kind: "activity"; t: number }
  /** The pipeline reset the recogniser after a pause (new segment). `silent`: no recitation
   *  tokens at all during the pause, rather than murmur without confident words. */
  | { kind: "segment"; t: number; silent?: boolean }
  /** Rolling input-quality estimate for the audio just processed. */
  | { kind: "quality"; t: number; snrDb: number; clipping: number; levelDb: number; speech: boolean };

export type ConfirmVia =
  | "continuation" // the expected next verse(s), supported by its own words
  | "discovery" // a new location found by search and accepted on its own evidence
  | "corroborated" // a held location confirmed by the verse after it, or by hearing nearly all of it
  | "repeat" // the same verse recited again after a pause
  | "inferred"; // missed by the recogniser between two confirmed neighbours of a running passage

export interface ConfirmedVerse {
  id: number;
  v: VerseRef;
  /** Audio-stream time (s) of the confirmation. */
  t: number;
  via: ConfirmVia;
  /** Other locations with word-for-word identical text when context could not decide. */
  ambiguousWith?: VerseRef[];
  /** Confirmed after a later verse (recogniser emitted it late). Sequential playback slots it
   *  back into order; Follow Live does not auto-play it. */
  late?: boolean;
  segment: number;
}

export type TrackerState = "listening" | "identifying" | "tracking" | "paused";

export type TrackerEvent =
  | { type: "state"; state: TrackerState }
  | {
      type: "tentative";
      v: VerseRef | null;
      progress: number;
      matchedWords: number;
      totalWords: number;
      reason: "tracking" | "pending";
    }
  | { type: "confirmed"; entry: ConfirmedVerse }
  /** An ambiguous identical-text entry resolved by what came next. */
  | { type: "revised"; id: number; v: VerseRef; previous: VerseRef }
  | { type: "dropped"; v: VerseRef; reason: string };
