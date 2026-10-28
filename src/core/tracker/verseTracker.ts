import { key, quranIndex, sameVerse, type QuranIndex, type VerseRef } from "../quran/quranIndex";
import type { ConfirmedVerse, ConfirmVia, Observation, PrayerContext, Sensitivity, TrackerEvent, TrackerState, WordEvidence } from "../types";
import { PRIORS } from "./priors";

export interface TrackerConfig {
  prayer: PrayerContext;
  sensitivity: Sensitivity;
  /** A pause at least this long between recitation means a new rak'ah in prayer contexts (s). */
  rakahPauseSec: number;
  /** No new recitation for this long → "paused" state (s). */
  pausedAfterSec: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  prayer: "general",
  sensitivity: "balanced",
  rakahPauseSec: 12,
  pausedAfterSec: 3,
};

/** A verse confirmed again this soon, without a silent pause in between, is a duplicate (s). */
const DUPLICATE_WINDOW_SEC = 30;

/**
 * Verses the recogniser may miss inside a running passage and still be filled in, once a later
 * verse of the same surah is confirmed (the reciter does not skip verses mid-passage).
 */
const GAP_FILL_MAX = 7;
/**
 * A passage that stops this close to its surah's end — at most this many ayahs, and this many
 * words, short of it — is completed by the reciter: short surahs and surah endings are recited
 * to the end. The unheard ending is filled in only when the recitation went on long enough
 * after the last verse heard to have covered it.
 */
const END_FILL_MAX_AYAHS = 3;
const END_FILL_MAX_WORDS = 20;
/**
 * A surah begun straight after Al-Fatihah is begun at its first verse. If the first verse heard
 * is its 2nd or 3rd (the opening was missed — often disjoined letters like Ha Mim or Qaf), the
 * opening is filled in when there was time to recite it.
 */
const OPENING_FILL_MAX_AYAH = 3;
const OPENING_FILL_MAX_WORDS = 20;
/** Recitation pace (s per word) before this session has measured one, and its sane range. */
const DEFAULT_PACE = 0.6;
const PACE_RANGE: [number, number] = [0.3, 1.5];

/** Discovery risk at or above this is held for corroboration. */
const RISK_LIMIT: Record<Sensitivity, number> = { careful: 0.5, balanced: 1, fast: 1.5 };

type Relation = "none" | "next" | "skip1" | "same" | "back" | "near" | "far";

interface Pending {
  v: VerseRef;
  /** v plus any word-for-word identical locations; the verse that follows decides which. */
  options: VerseRef[];
  since: number;
  reasons: string[];
  /** Pending because it jumps away from a running passage (not a fresh discovery). */
  jump: boolean;
}

/** A continuation verse whose words aligned but none of them confidently (see `strongEnough`). */
interface Weak {
  v: VerseRef;
  t: number;
}

interface Cursor {
  v: VerseRef;
  matched: number;
  total: number;
  t: number;
}

/**
 * Sequence- and context-aware verse confirmation on top of a word-level recogniser.
 *
 * The recogniser proposes; this decides. A proposal is confirmed when its own audio
 * evidence is sufficient *for its context*:
 *  - the next verse of the running passage needs only a few of its own words (never zero),
 *  - a new location (after a pause, after Al-Fatihah, at a surah end) is accepted on the
 *    recogniser's gate unless it is risky — very short, shares its opening half with
 *    another verse, near-identical to another verse, heard through poor audio, or the
 *    basmala — in which case it is held until the following verse or nearly all of its own
 *    words corroborate it,
 *  - a jump away from a running passage without a pause is always held for corroboration,
 *  - a continuation whose words aligned but none of them confidently (typically crowd noise
 *    after the imam has stopped being aligned to the next verse) is held until a later verse
 *    with confident words follows it; a pause drops it.
 * Prayer-context priors only lower the risk of favoured surahs; they never exclude anything.
 * Word-for-word identical verses are placed by context; with no context they are confirmed
 * with their alternatives listed and revised once the next verse settles the location.
 */
export class VerseTracker {
  cfg: TrackerConfig;
  private readonly q: QuranIndex;
  private nextId = 1;
  private last: ConfirmedVerse | null = null;
  private segment = 0;
  private segmentConfirms = new Set<string>();
  private segmentStarted = false;
  /** Pause length before the current segment's first recitation (s). */
  private pauseBefore = Infinity;
  private lastActivityT = -Infinity;
  private awaitingFirstActivity = true;
  private pending: Pending | null = null;
  private weak: Weak[] = [];
  /** When each verse was last confirmed (stream time, s). */
  private recent = new Map<string, number>();
  /** The current segment began after true silence (no tokens), not just murmur. */
  private afterSilence = true;
  private cursor: Cursor | null = null;
  private engineLocked = false;
  private poorAudio = false;
  private unresolved: ConfirmedVerse | null = null;
  private state: TrackerState = "listening";
  private lastTentativeKey = "";
  /** Verses confirmed from their own audio in the current segment. */
  private segmentHeard = 0;
  /** The most recent verse confirmed from its own audio (not filled in). */
  private lastHeard: ConfirmedVerse | null = null;
  /** Durations of consecutive heard verses this session: confirmation-to-confirmation (s). */
  private paceSamples: { dt: number; words: number }[] = [];

  constructor(cfg: Partial<TrackerConfig> = {}, q: QuranIndex = quranIndex) {
    this.cfg = { ...DEFAULT_TRACKER_CONFIG, ...cfg };
    this.q = q;
  }

  /** The most recent confirmed verse (context anchor), if any. */
  get anchor(): VerseRef | null {
    return this.last?.v ?? null;
  }

  /** Where the recogniser should look first after a reset, or null for an open search. */
  hint(): VerseRef | null {
    if (!this.last) return null;
    const v = this.last.v;
    if (v.s === 1 && v.a === 7) return null;
    return this.q.next(v);
  }

  reset(): void {
    this.last = null;
    this.segment = 0;
    this.segmentConfirms.clear();
    this.segmentStarted = false;
    this.pauseBefore = Infinity;
    this.lastActivityT = -Infinity;
    this.awaitingFirstActivity = true;
    this.pending = null;
    this.weak = [];
    this.recent.clear();
    this.afterSilence = true;
    this.cursor = null;
    this.engineLocked = false;
    this.unresolved = null;
    this.state = "listening";
    this.lastTentativeKey = "";
    this.segmentHeard = 0;
    this.lastHeard = null;
    this.paceSamples = [];
  }

  /**
   * Listening stopped: complete a surah ending the recogniser missed, if the recitation went
   * on long enough to have covered it.
   */
  finish(): TrackerEvent[] {
    const out: TrackerEvent[] = [];
    this.finishPassage(this.lastActivityT, out);
    return out;
  }

  observe(o: Observation): TrackerEvent[] {
    const out: TrackerEvent[] = [];
    switch (o.kind) {
      case "quality":
        this.poorAudio = o.speech && o.snrDb < 6;
        break;
      case "activity":
        if (this.awaitingFirstActivity) {
          this.pauseBefore = this.lastActivityT === -Infinity ? Infinity : o.t - this.lastActivityT;
          this.awaitingFirstActivity = false;
        }
        this.lastActivityT = o.t;
        if (!this.engineLocked) this.setState("identifying", out);
        break;
      case "segment":
        // The passage before this pause: fill in a surah ending that was recited but missed.
        this.finishPassage(this.lastActivityT, out);
        this.segment++;
        this.segmentHeard = 0;
        this.afterSilence = o.silent ?? true;
        this.segmentConfirms.clear();
        this.segmentStarted = true;
        this.awaitingFirstActivity = true;
        if (this.pending) {
          out.push({ type: "dropped", v: this.pending.v, reason: "pause before corroboration: " + this.pending.reasons.join(", ") });
          this.pending = null;
        }
        this.dropWeak("pause before a confident verse followed", out);
        this.cursor = null;
        this.engineLocked = false;
        this.setState("paused", out);
        break;
      case "located":
      case "relocated":
        this.engineLocked = true;
        break;
      case "lost":
        this.cursor = null;
        this.engineLocked = false;
        break;
      case "progress":
        this.onProgress(o, out);
        break;
      case "match":
        this.onMatch(o.v, o.t, o.evidence, out);
        break;
    }
    if (o.kind !== "segment" && this.state !== "listening" && o.t - this.lastActivityT >= this.cfg.pausedAfterSec && this.lastActivityT > -Infinity) {
      this.setState("paused", out);
    }
    this.emitTentative(out);
    return out;
  }

  // ---------------------------------------------------------------------------

  private setState(s: TrackerState, out: TrackerEvent[]): void {
    if (s === this.state) return;
    this.state = s;
    out.push({ type: "state", state: s });
  }

  private emitTentative(out: TrackerEvent[]): void {
    let ev: TrackerEvent;
    if (this.pending) {
      const c = this.cursor && sameVerse(this.cursor.v, this.pending.v) ? this.cursor : null;
      const total = this.q.words(this.pending.v);
      ev = { type: "tentative", v: this.pending.v, progress: c ? c.matched / Math.max(1, c.total) : 0, matchedWords: c?.matched ?? 0, totalWords: total, reason: "pending" };
    } else if (this.weak.length) {
      const w = this.weak[this.weak.length - 1]!;
      const total = this.q.words(w.v);
      ev = { type: "tentative", v: w.v, progress: 0, matchedWords: 0, totalWords: total, reason: "pending" };
    } else if (this.cursor && this.engineLocked && !this.segmentConfirms.has(key(this.cursor.v))) {
      const c = this.cursor;
      ev = { type: "tentative", v: c.v, progress: c.matched / Math.max(1, c.total), matchedWords: c.matched, totalWords: c.total, reason: "tracking" };
    } else {
      ev = { type: "tentative", v: null, progress: 0, matchedWords: 0, totalWords: 0, reason: "tracking" };
    }
    const k = ev.v ? `${key(ev.v)}|${ev.matchedWords}|${ev.reason}` : "none";
    if (k !== this.lastTentativeKey) {
      this.lastTentativeKey = k;
      out.push(ev);
    }
    if (this.cursor && this.engineLocked) this.setState("tracking", out);
  }

  /** Map a recogniser proposal onto the contextually right member of its identical-text group. */
  private place(v: VerseRef): { v: VerseRef; ambiguousWith?: VerseRef[] } {
    const group = this.q.identicalGroup(v);
    if (group.length < 2) return { v };
    const L = this.weak.length ? this.weak[this.weak.length - 1]!.v : this.last?.v;
    if (L) {
      const sameSurah = group.filter((g) => g.s === L.s);
      const ahead = sameSurah.filter((g) => g.a > L.a && g.a <= L.a + 2).sort((a, b) => a.a - b.a);
      if (ahead.length) return { v: ahead[0]! };
      const near = sameSurah.filter((g) => Math.abs(g.a - L.a) <= 8).sort((a, b) => Math.abs(a.a - L.a) - Math.abs(b.a - L.a));
      if (near.length) return { v: near[0]! };
    }
    // No context: keep the recogniser's pick, prefer prayer-favoured surahs, and report the rest.
    const w = PRIORS[this.cfg.prayer].weight;
    const best = [...group].sort((a, b) => w(b.s) - w(a.s))[0]!;
    const pick = w(best.s) > w(v.s) ? best : v;
    return { v: pick, ambiguousWith: group.filter((g) => !sameVerse(g, pick)) };
  }

  /** Relation of v to the last confirmed verse (or any of its identical-text alternatives). */
  private relation(v: VerseRef): Relation {
    const L = this.last;
    if (!L) return "none";
    const order: Relation[] = ["next", "skip1", "same", "back", "near", "far"];
    let best: Relation = "far";
    const anchors = this.weak.length ? [this.weak[this.weak.length - 1]!.v] : [L.v, ...(L.ambiguousWith ?? [])];
    for (const anchor of anchors) {
      let r: Relation = "far";
      if (v.s === anchor.s) {
        const d = v.a - anchor.a;
        r = d === 1 ? "next" : d === 2 ? "skip1" : d === 0 ? "same" : d < 0 && d >= -5 ? "back" : d > 2 && d <= 8 ? "near" : "far";
      }
      if (order.indexOf(r) < order.indexOf(best)) best = r;
    }
    return best;
  }

  /** True when a new location is expected rather than the continuation of the passage. */
  private atBoundary(): boolean {
    const L = this.last;
    if (!L) return true;
    if (L.segment !== this.segment) return true; // a pause separates us from the last verse
    if (L.v.s === 1 && L.v.a === 7) return true; // Al-Fatihah finished → a surah follows
    return this.q.isLastAyah(L.v);
  }

  private expectsFatihah(): boolean {
    const p = PRIORS[this.cfg.prayer];
    if (!p.expectsFatihahAfterLongPause) return false;
    return !this.last || this.pauseBefore >= this.cfg.rakahPauseSec;
  }

  /** Discovery risk: 0 = clean. See class doc. */
  private risk(v: VerseRef, heardFraction: number): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;
    // In salah, a basmala at the start of a rak'ah opens Al-Fatihah; anywhere else it could
    // open any surah, so it waits for the verse after it.
    if (v.s === 1 && v.a === 1 && !this.expectsFatihah()) {
      score += 2;
      reasons.push("basmala opens many surahs");
    }
    if (this.q.words(v) <= 3 && heardFraction < 0.85) {
      score += 1;
      reasons.push("very short verse");
    }
    if ((this.q.isPrefixTwin(v) || this.q.isNearTwin(v)) && heardFraction < 0.85) {
      score += 1;
      reasons.push("wording shared with another verse");
    }
    if (this.poorAudio) {
      score += 0.5;
      reasons.push("poor audio");
    }
    let w = PRIORS[this.cfg.prayer].weight(v.s);
    if (v.s === 1 && !this.expectsFatihah()) w = Math.min(w, 2);
    if (w >= 3) score -= 1;
    else if (w >= 2) score -= 0.5;
    return { score, reasons };
  }

  private heardFraction(v: VerseRef): number {
    if (!this.cursor || !sameVerse(this.cursor.v, v)) return 0;
    return this.cursor.matched / Math.max(1, this.cursor.total);
  }

  /** Words of its own a continuation verse must show before early confirmation. */
  private continuationWords(total: number): number {
    if (total <= 2) return total;
    if (total <= 8) return Math.ceil(total / 2);
    return Math.min(Math.ceil(total / 2), 4);
  }

  private onProgress(o: Extract<Observation, { kind: "progress" }>, out: TrackerEvent[]): void {
    const placed = this.place(o.v).v;
    this.cursor = { v: placed, matched: o.matched.length, total: o.totalWords || this.q.words(placed), t: o.t };
    this.engineLocked = true;
    const k = key(placed);
    // A held proposal is corroborated by the recogniser moving on into the verse after it,
    // or by hearing nearly all of its own words.
    if (this.pending) {
      const pend = this.pending;
      const before = o.matched.length >= 1 ? pend.options.find((m) => placed.s === m.s && placed.a === m.a + 1) : undefined;
      const full = sameVerse(placed, pend.v) && o.matched.length >= Math.max(1, Math.ceil(0.85 * this.cursor.total));
      if (before || full) {
        this.pending = null;
        this.confirm(before ?? pend.v, o.t, "corroborated", out);
      }
    }
    // A held weak continuation that now shows confident words is confirmed with those before it.
    const wi = this.weak.findIndex((w) => sameVerse(w.v, placed));
    if (wi >= 0) {
      if (strongEnough(o.evidence)) this.flushWeak(wi, o.t, out);
      return;
    }
    if (this.segmentConfirms.has(k)) return;
    const rel = this.relation(placed);
    if (this.pending || (rel !== "next" && rel !== "skip1")) return;
    // On course: the reciter is moving through a passage verse by verse, so the next verse is
    // confirmed as soon as its *opening* word is mostly and confidently heard — never before.
    // (Noise aligned to the next verse after the imam stops never has a confident opening word:
    // measured on the hall and pocket benchmark streams.)
    const firstWord = o.evidence ? o.evidence.first === true : o.matched.length >= 1;
    if (rel === "next" && this.onCourse() && firstWord) {
      this.continuation(placed, o.t, o.evidence, out);
      return;
    }
    // Otherwise (a verse skipped by the recogniser, or nothing confident yet) wait for more words.
    if (o.matched.length >= this.continuationWords(this.cursor.total) && o.matched.length > 0) {
      this.continuation(placed, o.t, o.evidence, out);
    }
  }

  /**
   * The last confirmed verse belongs to a passage being recited right now: same segment (no
   * pause since), and recently. Reciters in salah do not skip verses or jump mid-passage.
   */
  private onCourse(): boolean {
    const L = this.last;
    if (!L || this.weak.length) return false;
    return L.segment === this.segment && this.lastActivityT - L.t < 20;
  }

  /** Confirm a continuation verse, or hold it while its words carry no confident evidence. */
  private continuation(v: VerseRef, t: number, evidence: WordEvidence | undefined, out: TrackerEvent[], extra: { ambiguousWith?: VerseRef[] } = {}): void {
    if (strongEnough(evidence)) {
      this.flushWeak(this.weak.length - 1, t, out);
      // Verses the recogniser skipped between the last confirmed one and v are filled in by confirm().
      this.confirm(v, t, "continuation", out, extra);
      return;
    }
    if (!this.weak.some((w) => sameVerse(w.v, v))) this.weak.push({ v, t });
  }

  /** Confirm held weak continuations up to index i, in order. */
  private flushWeak(i: number, t: number, out: TrackerEvent[]): void {
    const take = this.weak.splice(0, i + 1);
    this.weak = [];
    for (const w of take) this.confirm(w.v, t, "corroborated", out);
  }

  private dropWeak(reason: string, out: TrackerEvent[]): void {
    for (const w of this.weak) out.push({ type: "dropped", v: w.v, reason });
    this.weak = [];
  }

  private onMatch(raw: VerseRef, t: number, evidence: WordEvidence | undefined, out: TrackerEvent[]): void {
    if (!this.q.isValid(raw)) return;
    const { v, ambiguousWith } = this.place(raw);
    const k = key(v);
    if (this.segmentConfirms.has(k)) return; // already confirmed from its words in this segment
    const wi = this.weak.findIndex((w) => sameVerse(w.v, v));
    if (wi >= 0) {
      if (strongEnough(evidence)) this.flushWeak(wi, t, out);
      return;
    }

    // A held proposal followed by its own continuation is corroborated.
    if (this.pending) {
      const pend = this.pending;
      const before = pend.options.find((m) => v.s === m.s && (v.a === m.a + 1 || v.a === m.a + 2));
      if (before) {
        this.pending = null;
        this.confirm(before, t, "corroborated", out);
      } else if (pend.options.some((m) => sameVerse(m, v))) {
        return; // same proposal again; keep waiting
      } else {
        // Superseded: the recogniser moved elsewhere (often back to the running passage).
        out.push({ type: "dropped", v: pend.v, reason: `superseded by ${k}` });
        this.pending = null;
      }
    }
    if (this.segmentConfirms.has(k)) return;

    const rel = this.relation(v);
    const boundary = this.atBoundary();
    if (rel === "next" || rel === "skip1") {
      this.continuation(v, t, evidence, out, { ambiguousWith });
      return;
    }
    // Anything else means the recogniser left the held weak continuations behind.
    this.dropWeak(`superseded by ${k}`, out);
    if (rel === "same") {
      // Only reachable after a pause (the recogniser never re-emits within a segment).
      if (this.last && this.last.segment !== this.segment) this.confirm(v, t, "repeat", out, { ambiguousWith });
      return;
    }
    if (rel === "back" && this.last && this.last.segment === this.segment && v.a === this.last.v.a - 1 && !this.segmentConfirms.has(k)) {
      // The recogniser passed its gate for the verse before the one we already confirmed.
      this.confirm(v, t, "continuation", out, { late: true });
      return;
    }
    const heard = this.heardFraction(v);
    const { score, reasons } = this.risk(v, heard);
    // A few verses further on in the same surah, mid-passage: the recogniser lost the thread and
    // found it again. Accepted on confident words if enough time has passed for the verses in
    // between to have been recited (they are filled in); otherwise held like any other jump.
    if (rel === "near" && !boundary && strongEnough(evidence) && score < RISK_LIMIT[this.cfg.sensitivity] && this.gapPlausible(v, t)) {
      this.continuation(v, t, evidence, out, { ambiguousWith });
      return;
    }
    const jump = !boundary && (rel === "far" || rel === "near" || rel === "back");
    if (jump) reasons.push("jump away from the running passage");
    if (!jump && score < RISK_LIMIT[this.cfg.sensitivity]) {
      this.confirm(v, t, "discovery", out, { ambiguousWith });
      return;
    }
    this.pending = { v, options: this.q.identicalGroup(v), since: t, reasons, jump };
  }

  /** Seconds per word, measured from consecutive verses heard this session. */
  private pace(): number {
    let dt = 0, words = 0;
    for (const p of this.paceSamples) {
      dt += p.dt;
      words += p.words;
    }
    if (!words) return DEFAULT_PACE;
    return Math.min(PACE_RANGE[1], Math.max(PACE_RANGE[0], dt / words));
  }

  private wordsBetween(s: number, fromA: number, toA: number): number {
    let n = 0;
    for (let a = fromA; a <= toA; a++) n += this.q.words({ s, a });
    return n;
  }

  /** The last confirmed verse and v belong to one running passage (no long pause between). */
  private sameRun(L: ConfirmedVerse): boolean {
    if (L.segment === this.segment) return true;
    // A short pause mid-passage (a breath, or a reset in noise) — not a rak'ah change.
    return L.segment === this.segment - 1 && this.pauseBefore < this.cfg.rakahPauseSec;
  }

  /**
   * Enough time has passed since the last confirmed verse for the verses between it and v to
   * have been recited — at half the measured pace, so fast recitation still qualifies.
   */
  private gapPlausible(v: VerseRef, t: number): boolean {
    const L = this.weak.length ? { v: this.weak[this.weak.length - 1]!.v, t: this.weak[this.weak.length - 1]!.t } : this.last;
    if (!L || L.v.s !== v.s || v.a <= L.v.a) return false;
    if (v.a - L.v.a - 1 > GAP_FILL_MAX) return false;
    return t - L.t >= 0.5 * this.pace() * this.wordsBetween(v.s, L.v.a, v.a - 1);
  }

  /** Fill in verses the recogniser missed between the last confirmed verse and v. */
  private fillGap(v: VerseRef, t: number, out: TrackerEvent[]): void {
    const L = this.last;
    if (!L || L.late || L.v.s !== v.s || !this.sameRun(L)) return;
    const gap = v.a - L.v.a - 1;
    if (gap < 1 || gap > GAP_FILL_MAX) return;
    // One verse between two heard neighbours is always filled; longer gaps need the time too.
    if (gap > 1 && !this.gapPlausible(v, t)) return;
    for (let a = L.v.a + 1; a < v.a; a++) {
      if (!this.segmentConfirms.has(`${v.s}:${a}`)) this.confirm({ s: v.s, a }, t, "inferred", out);
    }
  }

  /**
   * A surah recited right after Al-Fatihah starts at its first verse: if the first verse heard is
   * its 2nd or 3rd, fill in the opening — when the time since Al-Fatihah allowed it to be recited.
   */
  private fillOpening(v: VerseRef, t: number, out: TrackerEvent[]): void {
    if (v.s === 1 || v.a < 2 || v.a > OPENING_FILL_MAX_AYAH) return;
    const L = this.last;
    if (!L || L.v.s !== 1 || L.v.a !== 7 || !this.sameRun(L)) return;
    const H = this.lastHeard;
    if (!H || H.v.s !== 1) return;
    const opening = this.wordsBetween(v.s, 1, v.a - 1);
    if (opening > OPENING_FILL_MAX_WORDS) return;
    // The rest of Al-Fatihah from the last verse heard, then at least half the opening's words.
    if (t - H.t < this.pace() * (this.wordsBetween(1, H.v.a, 7) + 0.5 * opening)) return;
    for (let a = 1; a < v.a; a++) {
      if (!this.segmentConfirms.has(`${v.s}:${a}`)) this.confirm({ s: v.s, a }, t, "inferred", out);
    }
  }

  /**
   * The running passage ended (a pause, the end of listening, or the recitation moved to another
   * passage). If it stopped a few short verses before its surah's end and the recitation went on
   * long enough after the last verse heard to have covered the rest, the reciter finished the
   * surah: confirm the remaining verses so their translations play too.
   */
  private finishPassage(tEnd: number, out: TrackerEvent[]): void {
    const L = this.last;
    if (!L || L.late || L.ambiguousWith || L.segment !== this.segment) return;
    if (this.segmentHeard < 2) return; // a running passage, not a lone verse
    const s = L.v.s;
    const total = this.q.ayahCount(s);
    const remaining = total - L.v.a;
    if (remaining < 1 || remaining > END_FILL_MAX_AYAHS) return;
    const restWords = this.wordsBetween(s, L.v.a + 1, total);
    if (restWords > END_FILL_MAX_WORDS) return;
    // The last verse heard was confirmed near its start: its own words, then most of the rest.
    const need = this.pace() * (this.q.words(L.v) + 0.6 * restWords);
    if (tEnd - L.t < need) return;
    for (let a = L.v.a + 1; a <= total; a++) {
      if (!this.segmentConfirms.has(`${s}:${a}`)) this.confirm({ s, a }, tEnd, "completed", out);
    }
    this.weak = this.weak.filter((w) => !this.segmentConfirms.has(key(w.v)));
    if (this.pending && this.segmentConfirms.has(key(this.pending.v))) this.pending = null;
  }

  private confirm(v: VerseRef, t: number, via: ConfirmVia, out: TrackerEvent[], extra: { ambiguousWith?: VerseRef[]; late?: boolean } = {}): void {
    // The recogniser restarted inside noisy recitation and found the same verses again.
    const prev = this.recent.get(key(v));
    if (prev !== undefined && !this.afterSilence && t - prev < DUPLICATE_WINDOW_SEC) {
      this.segmentConfirms.add(key(v));
      out.push({ type: "dropped", v, reason: "already confirmed moments ago" });
      return;
    }
    const heardIt = via !== "inferred" && via !== "completed";
    if (heardIt && !extra.late) {
      const L = this.last;
      if (L && L.segment === this.segment && v.s !== L.v.s) {
        // The recitation moved on to another surah: finish the one before it first.
        this.finishPassage(t, out);
      } else {
        this.fillGap(v, t, out);
      }
      this.fillOpening(v, t, out);
      // Pace: the time from one heard verse to the next is the first one's recitation.
      const P = this.last;
      if (P && P.segment === this.segment && P.v.s === v.s && v.a === P.v.a + 1 && P.via === "continuation" && via === "continuation" && t > P.t) {
        this.paceSamples.push({ dt: t - P.t, words: this.q.words(P.v) });
        if (this.paceSamples.length > 16) this.paceSamples.shift();
      }
      this.segmentHeard++;
    }
    this.recent.set(key(v), t);
    // Resolve an earlier ambiguous identical-text entry from what follows it.
    if (this.unresolved && this.unresolved.segment === this.segment && !sameVerse(this.unresolved.v, v)) {
      const u = this.unresolved;
      const options = [u.v, ...(u.ambiguousWith ?? [])];
      const fit = options.filter((g) => g.s === v.s && (v.a - g.a === 1 || v.a - g.a === 2));
      if (fit.length === 1 && !sameVerse(fit[0], u.v)) {
        out.push({ type: "revised", id: u.id, v: fit[0]!, previous: u.v });
        u.v = fit[0]!;
        this.segmentConfirms.add(key(fit[0]!));
      }
      if (fit.length === 1) delete u.ambiguousWith;
      // Settled, or the recitation moved on without settling it: either way stop trying.
      this.unresolved = null;
    }
    const entry: ConfirmedVerse = { id: this.nextId++, v, t, via, segment: this.segment };
    if (extra.ambiguousWith?.length) entry.ambiguousWith = extra.ambiguousWith;
    if (extra.late) entry.late = true;
    if (!extra.late) this.last = entry;
    if (heardIt && !extra.late) this.lastHeard = entry;
    this.segmentConfirms.add(key(v));
    if (entry.ambiguousWith) this.unresolved = entry;
    out.push({ type: "confirmed", entry });
  }
}

/**
 * At least one word of the verse matched closely AND with a clear model margin. Recitation
 * almost always gives several; crowd noise aligned to a verse gives none (measured on the
 * benchmark's hall and pocket streams). No evidence attached (other recognisers) counts as yes.
 */
export function strongEnough(e: WordEvidence | undefined): boolean {
  return !e || e.strong >= 1;
}
