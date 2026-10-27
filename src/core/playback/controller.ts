import type { ConfirmedVerse, VerseRef } from "../types";

export type PlaybackMode = "follow" | "sequential";

export interface PlayItem {
  /** History entry this clip belongs to (manual whole-surah plays use the entry they came from). */
  entryId: number;
  kind: "ayah" | "surah";
  v: VerseRef;
  manual: boolean;
}

/** Plays one clip at a time. `play` resolves when the clip ends or is stopped. */
export interface ClipPlayer {
  play(item: PlayItem): Promise<"ended" | "stopped" | "missing" | "error">;
  stop(): void;
  pause(): void;
  resume(): void;
}

export interface PlaybackState {
  current: PlayItem | null;
  paused: boolean;
  queued: PlayItem[];
  /** The last verse whose translation file was not found, for the UI. */
  missing: VerseRef | null;
  /** Clips dropped to stay close to the live recitation (Follow Live) or by the queue cap. */
  skipped: number;
}

/**
 * Translation playback policy.
 *
 * Follow Live (default): at most one clip waits behind the one playing. A newer confirmed
 * verse replaces the waiting one, so playback is never more than one verse behind the imam.
 * Late entries (a verse confirmed after the one that follows it) are not auto-played.
 *
 * Sequential: every confirmed verse plays once, in order. The queue is capped (default 12):
 * beyond that the oldest waiting clips are dropped and counted, never played twice.
 *
 * Every history entry auto-plays at most once — overlapping recognition can't retrigger it,
 * and a verse that stays on screen is not replayed. A legitimately repeated verse is a new
 * history entry and plays again. Manual replays interrupt auto playback; auto playback then
 * resumes with the newest waiting clip.
 */
export class PlaybackController {
  mode: PlaybackMode;
  autoPlay = true;
  queueCap = 12;
  private player: ClipPlayer;
  private queue: PlayItem[] = [];
  private current: PlayItem | null = null;
  private paused = false;
  private played = new Set<number>();
  private missing: VerseRef | null = null;
  private skipped = 0;
  private listeners = new Set<(s: PlaybackState) => void>();
  private running = false;

  constructor(player: ClipPlayer, mode: PlaybackMode = "follow") {
    this.player = player;
    this.mode = mode;
  }

  subscribe(fn: (s: PlaybackState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  get state(): PlaybackState {
    return { current: this.current, paused: this.paused, queued: [...this.queue], missing: this.missing, skipped: this.skipped };
  }

  private emit(): void {
    const s = this.state;
    for (const l of this.listeners) l(s);
  }

  /** A verse was confirmed by the tracker. */
  onConfirmed(entry: ConfirmedVerse): void {
    if (!this.autoPlay || this.played.has(entry.id)) return;
    if (entry.late && this.mode === "follow") return;
    this.played.add(entry.id);
    const item: PlayItem = { entryId: entry.id, kind: "ayah", v: entry.v, manual: false };
    if (this.mode === "follow") {
      const dropped = this.queue.filter((q) => !q.manual).length;
      this.skipped += dropped;
      this.queue = this.queue.filter((q) => q.manual);
      this.queue.push(item);
    } else {
      this.queue.push(item);
      const auto = this.queue.filter((q) => !q.manual);
      if (auto.length > this.queueCap) {
        const drop = new Set(auto.slice(0, auto.length - this.queueCap));
        this.skipped += drop.size;
        this.queue = this.queue.filter((q) => !drop.has(q));
      }
    }
    this.emit();
    void this.pump();
  }

  /** An ambiguous entry was placed: a clip not yet played follows the new location. */
  onRevised(id: number, v: VerseRef): void {
    for (const q of this.queue) if (q.entryId === id && q.kind === "ayah") q.v = v;
    this.emit();
  }

  /** Tap on history: replay that verse's translation now. */
  playManual(entryId: number, v: VerseRef, kind: "ayah" | "surah" = "ayah"): void {
    this.playSequence([{ entryId, kind, v }]);
  }

  /** Play several clips in order now (a passage, or a surah from a chosen verse). */
  playSequence(items: { entryId: number; kind: "ayah" | "surah"; v: VerseRef }[]): void {
    if (!items.length) return;
    const manual: PlayItem[] = items.map((i) => ({ ...i, manual: true }));
    this.queue = [...manual, ...this.queue.filter((q) => !q.manual)];
    this.paused = false;
    if (this.current) this.player.stop(); // pump picks up the first manual item next
    this.emit();
    void this.pump();
  }

  /** Stop whatever is playing and clear waiting clips. */
  stopAll(): void {
    this.queue = [];
    this.paused = false;
    if (this.current) this.player.stop();
    this.emit();
  }

  /** Skip the clip playing now. */
  skip(): void {
    if (this.current) this.player.stop();
  }

  togglePause(): void {
    if (!this.current) return;
    this.paused = !this.paused;
    if (this.paused) this.player.pause();
    else this.player.resume();
    this.emit();
  }

  resetSession(): void {
    this.stopAll();
    this.played.clear();
    this.missing = null;
    this.skipped = 0;
    this.emit();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        this.current = item;
        this.paused = false;
        this.emit();
        const r = await this.player.play(item);
        if (r === "missing") this.missing = item.v;
        else if (r === "ended") this.missing = null;
        this.current = null;
        this.emit();
      }
    } finally {
      this.running = false;
    }
  }
}
