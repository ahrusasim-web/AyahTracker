import { createZipformerSession, type ZipformerSession, type WorkerOutbound } from "@tilawa/core";
import type { Observation, VerseRef, WordEvidence } from "../types";

/**
 * The seam between the acoustic recogniser and everything else. Any model that can turn
 * 16 kHz PCM into word-level verse observations can implement this.
 */
export interface Recognizer {
  readonly name: string;
  /** Feed 16 kHz mono PCM; `t` is the stream time (s) at the end of the chunk. */
  feed(pcm: Float32Array, t: number): Promise<Observation[]>;
  /** Clear all recognition state (used at pauses, so a repeated verse can be heard again). */
  reset(): void;
  /** Tie-break the next search toward this location (soft; never restricts). */
  setHint(v: VerseRef | null): void;
  /** Total transcript length so far; grows whenever new recitation tokens are heard. */
  readonly activityCount: number;
}

/** A heard word counts as strong evidence at or under this phoneme distance… */
export const STRONG_MAX_DISTANCE = 0.2;
/** …and at or above this CTC confidence margin. Tuned on the benchmark (see README). */
export const STRONG_MIN_MARGIN = 0.5;

export interface TilawaRecognizerOptions {
  /** The onnxruntime namespace: onnxruntime-web in the browser, onnxruntime-node in tests. */
  ort: unknown;
  model: ArrayBuffer | Uint8Array | (() => Promise<ArrayBuffer | Uint8Array>);
  corpus: unknown | (() => Promise<unknown>);
  quran?: unknown[] | (() => Promise<unknown[]>);
  executionProviders?: string[];
}

/**
 * Tilawa streaming Zipformer2-CTC (tajweed-phoneme vocabulary) + its word-level aligner.
 * Model weights: Quran-Lab / Tilawa, NPL-1.2. SDK: MIT.
 */
export class TilawaRecognizer implements Recognizer {
  readonly name = "tilawa-zipformer-a0w";
  private session!: ZipformerSession;
  private hintRef: VerseRef | null = null;
  private transcriptLen = 0;
  private activity = 0;

  static async create(opts: TilawaRecognizerOptions): Promise<TilawaRecognizer> {
    const r = new TilawaRecognizer();
    r.session = await createZipformerSession({
      ort: opts.ort,
      model: opts.model as never,
      corpus: opts.corpus,
      quran: opts.quran as never,
      executionProviders: opts.executionProviders,
      debug: true,
      enableFallback: false, // whole-ayah guessing at the end of a take is not wanted live
    });
    return r;
  }

  get activityCount(): number {
    return this.activity;
  }

  setHint(v: VerseRef | null): void {
    this.hintRef = v;
    this.applyHint();
  }

  private applyHint(): void {
    // The SDK keeps the engine private; its search accepts a surah/ayah tie-break hint.
    const engine = (this.session as unknown as { engine?: { setHint?: (h: { surah: number; ayah: number } | null) => void } }).engine;
    engine?.setHint?.(this.hintRef ? { surah: this.hintRef.s, ayah: this.hintRef.a } : null);
  }

  reset(): void {
    this.session.reset();
    this.transcriptLen = 0;
    this.applyHint();
  }

  async feed(pcm: Float32Array, t: number): Promise<Observation[]> {
    const msgs = await this.session.feed(pcm);
    return this.convert(msgs, t);
  }

  /** Word evidence for one verse from the aligner's settled verdicts. */
  private evidence(v: VerseRef): WordEvidence | undefined {
    const tracer = (this.session as unknown as { engine?: { tracer?: { verdicts(settled: boolean): unknown[] } } }).engine?.tracer;
    if (!tracer) return undefined;
    let heard = 0, strong = 0, wrong = 0, first = false;
    for (const w of tracer.verdicts(true) as { surah: number; ayah: number; word: number; state: string; distance: number; margin: number; heardRatio?: number }[]) {
      if (w.surah !== v.s || w.ayah !== v.a) continue;
      const confident = w.distance <= STRONG_MAX_DISTANCE && w.margin >= STRONG_MIN_MARGIN;
      if (w.state === "ok" || w.state === "unsure") {
        heard++;
        if (confident) strong++;
      } else if (w.state === "wrong") wrong++;
      // The opening word, even while it is still being recited: mostly heard, closely.
      if (w.word === 0 && w.state !== "wrong" && w.state !== "skipped" && confident && (w.heardRatio ?? 0) >= 0.6) first = true;
    }
    return { heard, strong, wrong, first };
  }

  private convert(msgs: WorkerOutbound[], t: number): Observation[] {
    const out: Observation[] = [];
    for (const m of msgs) {
      switch (m.type) {
        case "raw_transcript": {
          const len = m.text.length;
          if (len > this.transcriptLen) {
            this.activity += len - this.transcriptLen;
            out.push({ kind: "activity", t });
          }
          this.transcriptLen = len;
          break;
        }
        case "word_progress":
          out.push({ kind: "progress", t, v: { s: m.surah, a: m.ayah }, wordIndex: m.word_index, totalWords: m.total_words, matched: m.matched_indices, evidence: this.evidence({ s: m.surah, a: m.ayah }) });
          break;
        case "verse_match":
          out.push({ kind: "match", t, v: { s: m.surah, a: m.ayah }, confidence: m.confidence, evidence: this.evidence({ s: m.surah, a: m.ayah }) });
          break;
        case "debug": {
          const d = m.data as { type?: string; surah?: number; ayah?: number; to?: { surah: number; ayah: number } };
          if (m.event === "located" && d.surah && d.ayah) out.push({ kind: "located", t, v: { s: d.surah, a: d.ayah } });
          else if (m.event === "relocated" && d.to) out.push({ kind: "relocated", t, to: { s: d.to.surah, a: d.to.ayah } });
          else if (m.event === "lost" || m.event === "idle") out.push({ kind: "lost", t });
          break;
        }
        default:
          break;
      }
    }
    return out;
  }
}
