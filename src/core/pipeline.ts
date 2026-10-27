import { AudioConditioner, DEFAULT_CONDITIONER, type AudioQuality, type ConditionerOptions } from "./audio/conditioner";
import type { Recognizer } from "./engine/recognizer";
import { VerseTracker, type TrackerConfig } from "./tracker/verseTracker";
import type { Observation, TrackerEvent } from "./types";

export interface PipelineOptions {
  tracker: Partial<TrackerConfig>;
  conditioner: Partial<ConditionerOptions>;
  /** Reset the recogniser after this long without new recitation (s). Lets a verse be heard again. */
  pauseResetSec: number;
  /**
   * Also reset after this long without any confidently heard word, even if the recogniser keeps
   * emitting tokens (crowd murmur during ruku and sujud does that). Only applies once something
   * was confidently heard since the last reset, so it never interrupts an initial search (s).
   */
  evidencePauseSec: number;
  /** Process audio in chunks of this many samples at 16 kHz (320 ms default). */
  chunkSamples: number;
}

export const DEFAULT_PIPELINE: PipelineOptions = {
  tracker: {},
  conditioner: DEFAULT_CONDITIONER,
  pauseResetSec: 4,
  evidencePauseSec: 7,
  chunkSamples: 5120,
};

export type PipelineEvent = TrackerEvent | { type: "quality"; t: number; quality: AudioQuality } | { type: "segment"; t: number };

/**
 * 16 kHz PCM in → confirmed verses out.
 * conditioner → recogniser → tracker, plus pause detection that resets the recogniser
 * (so Al-Fatihah is heard afresh in every rak'ah) and re-hints it with the expected
 * continuation.
 */
export class RecognitionPipeline {
  readonly tracker: VerseTracker;
  readonly conditioner: AudioConditioner;
  opts: PipelineOptions;
  private readonly rec: Recognizer;
  private pendingBuf: Float32Array;
  private pendingFill = 0;
  private samples = 0;
  private lastActivityT = 0;
  private activitySinceReset = false;
  private lastActivityCount = 0;
  private lastEvidenceT = 0;
  private evidenceSinceReset = false;
  private lastStrong = "";
  private qualityTick = 0;
  /** Seconds of audio processed by the recogniser, and the wall time it took (ms). */
  stats = { audioSec: 0, computeMs: 0, chunks: 0, maxChunkMs: 0 };

  constructor(rec: Recognizer, opts: Partial<PipelineOptions> = {}) {
    this.rec = rec;
    this.opts = { ...DEFAULT_PIPELINE, ...opts, tracker: { ...opts.tracker }, conditioner: { ...DEFAULT_CONDITIONER, ...opts.conditioner } };
    this.tracker = new VerseTracker(this.opts.tracker);
    this.conditioner = new AudioConditioner(this.opts.conditioner);
    this.pendingBuf = new Float32Array(this.opts.chunkSamples);
  }

  get timeSec(): number {
    return this.samples / 16000;
  }

  /** Start a new listening session (keeps the loaded model). */
  restart(): void {
    this.rec.reset();
    this.rec.setHint(null);
    this.tracker.reset();
    this.conditioner.reset();
    this.pendingFill = 0;
    this.samples = 0;
    this.lastActivityT = 0;
    this.activitySinceReset = false;
    this.evidenceSinceReset = false;
    this.lastEvidenceT = 0;
    this.lastStrong = "";
    this.lastActivityCount = this.rec.activityCount;
    this.stats = { audioSec: 0, computeMs: 0, chunks: 0, maxChunkMs: 0 };
  }

  /**
   * Audio was lost (e.g. the device fell behind and samples were dropped): treat it as a pause
   * so the recogniser starts clean instead of aligning across the hole.
   */
  gap(): PipelineEvent[] {
    this.rec.reset();
    this.rec.setHint(this.tracker.hint());
    this.pendingFill = 0;
    this.activitySinceReset = false;
    this.evidenceSinceReset = false;
    this.lastStrong = "";
    this.lastActivityCount = this.rec.activityCount;
    const t = this.timeSec;
    return [{ type: "segment", t }, ...this.tracker.observe({ kind: "segment", t })];
  }

  /** Push any amount of 16 kHz audio; processes whole chunks as they fill. */
  async push(pcm: Float32Array): Promise<PipelineEvent[]> {
    const out: PipelineEvent[] = [];
    let i = 0;
    while (i < pcm.length) {
      const n = Math.min(pcm.length - i, this.pendingBuf.length - this.pendingFill);
      this.pendingBuf.set(pcm.subarray(i, i + n), this.pendingFill);
      this.pendingFill += n;
      i += n;
      if (this.pendingFill === this.pendingBuf.length) {
        out.push(...(await this.processChunk(this.pendingBuf.slice())));
        this.pendingFill = 0;
      }
    }
    return out;
  }

  private async processChunk(chunk: Float32Array): Promise<PipelineEvent[]> {
    const out: PipelineEvent[] = [];
    const { out: conditioned, quality } = this.conditioner.process(chunk);
    this.samples += chunk.length;
    const t = this.timeSec;
    const t0 = now();
    const obs: Observation[] = await this.rec.feed(conditioned, t);
    const ms = now() - t0;
    this.stats.audioSec += chunk.length / 16000;
    this.stats.computeMs += ms;
    this.stats.chunks++;
    this.stats.maxChunkMs = Math.max(this.stats.maxChunkMs, ms);

    const q: Observation = { kind: "quality", t, snrDb: quality.snrDb, clipping: quality.clipping, levelDb: quality.levelDb, speech: quality.speech };
    out.push(...this.tracker.observe(q));
    if (++this.qualityTick % 3 === 0) out.push({ type: "quality", t, quality });

    if (this.rec.activityCount > this.lastActivityCount) {
      this.lastActivityCount = this.rec.activityCount;
      this.lastActivityT = t;
      this.activitySinceReset = true;
    }
    for (const o of obs) {
      if ((o.kind === "progress" || o.kind === "match") && o.evidence && o.evidence.strong > 0) {
        const k = `${o.v.s}:${o.v.a}:${o.evidence.strong}`;
        if (k !== this.lastStrong) {
          this.lastStrong = k;
          this.lastEvidenceT = t;
          this.evidenceSinceReset = true;
        }
      }
      out.push(...this.tracker.observe(o));
    }

    const silent = this.activitySinceReset && t - this.lastActivityT >= this.opts.pauseResetSec;
    const noEvidence = this.evidenceSinceReset && t - this.lastEvidenceT >= this.opts.evidencePauseSec;
    if (silent || noEvidence) {
      this.rec.reset();
      this.rec.setHint(this.tracker.hint());
      this.activitySinceReset = false;
      this.evidenceSinceReset = false;
      this.lastStrong = "";
      this.lastActivityCount = this.rec.activityCount;
      out.push({ type: "segment", t });
      out.push(...this.tracker.observe({ kind: "segment", t, silent }));
    }
    return out;
  }
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
