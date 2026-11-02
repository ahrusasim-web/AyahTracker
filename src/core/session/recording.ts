/** Pure helpers for session recordings (no browser APIs, so they can be unit-tested). */

/** MediaRecorder formats, best first: Opus in WebM (Chrome, Android, Firefox), then MP4 (Safari). */
export const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];

/** About 14 MB an hour; plenty for recitation (Opus is transparent for speech well below this). */
export const RECORDING_BITRATE = 32000;

export function pickRecordingType(isSupported: (t: string) => boolean): string | null {
  return RECORDING_TYPES.find((t) => isSupported(t)) ?? null;
}

export function extensionFor(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "audio";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Ayah Live 2026-11-02 13.05 Jummah.webm" — no characters phones reject in file names. */
export function recordingFileName(startedAt: number, prayerLabel: string | null, mime: string): string {
  const d = new Date(startedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  return `Ayah Live ${stamp}${prayerLabel ? " " + prayerLabel : ""}.${extensionFor(mime)}`;
}

/**
 * Playback gain that brings the recording's speech to a comfortable level. A phone several rows
 * back in a mosque records the imam at around -40 dBFS; played back as is, that is barely audible.
 * The level is measured while recording (loud parts of speech, frame RMS); a limiter follows.
 */
export function playbackGainDb(speechDb: number | undefined): number {
  if (speechDb === undefined || !Number.isFinite(speechDb)) return 6;
  return Math.max(0, Math.min(24, -20 - speechDb));
}

interface TimedEntry {
  v: { s: number; a: number };
  wall: number;
  fromWall?: number;
  fromSure?: boolean;
}

/**
 * When the verse at `i` began (wall ms). Starts measured from a verse's own words are used as
 * they are; the rest (verses found late, or filled in) are placed between the nearest measured
 * neighbours of the same passage in proportion to their words, since recitation pace is steady
 * within a passage.
 */
export function verseStartWall(entries: TimedEntry[], i: number, words: (v: { s: number; a: number }) => number): number {
  const e = entries[i]!;
  const fallback = e.fromWall ?? e.wall - 2500;
  if (e.fromSure && e.fromWall !== undefined) return e.fromWall;
  const samePassage = (o: TimedEntry) => o.v.s === e.v.s && Math.abs(o.wall - e.wall) < 120_000;
  let before: TimedEntry | undefined, after: TimedEntry | undefined;
  for (let j = i - 1; j >= 0; j--) {
    const o = entries[j]!;
    if (!samePassage(o) || o.v.a >= e.v.a) break;
    if (o.fromSure && o.fromWall !== undefined) { before = o; break; }
  }
  for (let j = i + 1; j < entries.length; j++) {
    const o = entries[j]!;
    if (!samePassage(o) || o.v.a <= e.v.a) break;
    if (o.fromSure && o.fromWall !== undefined) { after = o; break; }
  }
  if (!before || !after || after.fromWall! <= before.fromWall!) return fallback;
  let total = 0, upTo = 0;
  for (let a = before.v.a; a < after.v.a; a++) {
    const w = Math.max(1, words({ s: e.v.s, a }));
    if (a < e.v.a) upTo += w;
    total += w;
  }
  return before.fromWall! + ((after.fromWall! - before.fromWall!) * upTo) / total;
}

/** Where to start playing (s into the recording): a moment before `startWall`. */
export function seekSeconds(startWall: number, rec: { startedWall: number; durationMs: number }): number {
  const s = (startWall - rec.startedWall) / 1000 - 0.5;
  return Math.max(0, Math.min(s, Math.max(0, rec.durationMs / 1000 - 1)));
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1]! + a[m]!) / 2;
}
