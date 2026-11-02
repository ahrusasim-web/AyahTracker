import { useSyncExternalStore } from "react";
import type { PlaybackMode, PlaybackState } from "../core/playback/controller";
import type { LibraryStats } from "../core/playback/library";
import type { ConfirmVia, PrayerContext, Sensitivity, TrackerState, VerseRef } from "../core/types";

export interface Settings {
  prayer: PrayerContext;
  sensitivity: Sensitivity;
  playbackMode: PlaybackMode;
  autoTranslate: boolean;
  /** Speed translations up slightly (≤1.25×) while several are waiting. */
  catchUp: boolean;
  keepScreenOn: boolean;
  /** Translations play through the phone speaker: let the browser cancel them from the mic. */
  speakerMode: boolean;
  conditioning: boolean;
  /** Optional hosted translations folder, e.g. "translations/". */
  libraryUrl: string;
  mediaKeys: boolean;
  /** Record the recitation while listening, kept on this phone with the session. */
  record: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  prayer: "general",
  sensitivity: "balanced",
  playbackMode: "sequential",
  autoTranslate: true,
  catchUp: true,
  keepScreenOn: true,
  speakerMode: false,
  conditioning: true,
  libraryUrl: "",
  mediaKeys: true,
  record: true,
};

export interface HistoryEntry {
  id: number;
  v: VerseRef;
  /** Wall-clock time the verse was confirmed (ms since epoch). */
  wall: number;
  via: ConfirmVia;
  ambiguousWith?: VerseRef[];
  late?: boolean;
  /** Estimated wall-clock time the verse's recitation began (ms), for finding it in the recording. */
  fromWall?: number;
  /** fromWall was measured from the verse's own words rather than inferred. */
  fromSure?: boolean;
}

export interface SavedSession {
  startedAt: number;
  prayer: PrayerContext;
  entries: HistoryEntry[];
  /** The recitation was recorded (the audio itself is in IndexedDB, keyed by startedAt). */
  recorded?: boolean;
}

/** The session recording player (one at a time). */
export interface RecPlayState {
  id: number | null;
  loading: boolean;
  playing: boolean;
  /** Position and length (s). */
  t: number;
  duration: number;
}

export type ListenPhase = "idle" | "starting" | "listening" | "stopping";

export interface AppState {
  engine: { status: "loading" | "ready" | "error"; progress: number; detail: string; error?: string; threads?: number; rtf?: number; backlogSec?: number };
  listen: ListenPhase;
  tracker: TrackerState;
  tentative: { v: VerseRef; progress: number; matchedWords: number; totalWords: number; reason: "tracking" | "pending" } | null;
  history: HistoryEntry[];
  sessionStartedAt: number | null;
  quality: { snrDb: number; levelDb: number; gainDb: number; speech: boolean } | null;
  playback: PlaybackState;
  library: LibraryStats & {
    source: "device" | "url" | "device+url" | "none";
    importing: { done: number; total: number } | null;
    /** Verse files per surah (index 0 = surah 1) and whole-surah files, for files on this device. */
    coverage: { verses: number[]; surahFile: boolean[] };
  };
  settings: Settings;
  notice: { text: string; tone: "info" | "warn" | "error" } | null;
  mediaKeysAvailable: boolean;
  /** The recording being made right now, if any. */
  recording: { id: number; startedWall: number } | null;
  /** Bumped whenever a stored recording is added, finished or removed. */
  recVersion: number;
  recPlay: RecPlayState;
}

const SETTINGS_KEY = "ayahlive.settings.v2";
/** v1 defaulted to Follow Live; v2 keeps everything else the user chose but moves to Sequential. */
const OLD_SETTINGS_KEY = "ayahlive.settings.v1";
const SESSIONS_KEY = "ayahlive.sessions.v1";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    const old = localStorage.getItem(OLD_SETTINGS_KEY);
    if (old) return { ...DEFAULT_SETTINGS, ...JSON.parse(old), playbackMode: "sequential" };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function loadSessions(): SavedSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Sessions kept on this phone (with their recordings). */
export const SESSIONS_KEPT = 12;

export function saveSession(s: SavedSession): void {
  if (!s.entries.length && !s.recorded) return;
  try {
    const all = loadSessions().filter((x) => x.startedAt !== s.startedAt);
    const prev = loadSessions().find((x) => x.startedAt === s.startedAt);
    all.push({ ...s, recorded: s.recorded || prev?.recorded || undefined });
    all.sort((a, b) => b.startedAt - a.startedAt);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(all.slice(0, SESSIONS_KEPT)));
  } catch {
    /* ignore */
  }
}

export function clearSessions(): void {
  try {
    localStorage.removeItem(SESSIONS_KEY);
  } catch {
    /* ignore */
  }
}

let state: AppState = {
  engine: { status: "loading", progress: 0, detail: "Preparing the recogniser" },
  listen: "idle",
  tracker: "listening",
  tentative: null,
  history: [],
  sessionStartedAt: null,
  quality: null,
  playback: { current: null, paused: false, queued: [], missing: null, skipped: 0 },
  library: {
    ayahFiles: 0, surahFiles: 0, missingAyahs: 6236, duplicates: [], ignored: 0, cues: [], source: "none", importing: null,
    coverage: { verses: new Array<number>(114).fill(0), surahFile: new Array<boolean>(114).fill(false) },
  },
  settings: loadSettings(),
  notice: null,
  mediaKeysAvailable: typeof navigator !== "undefined" && "mediaSession" in navigator,
  recording: null,
  recVersion: 0,
  recPlay: { id: null, loading: false, playing: false, t: 0, duration: 0 },
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
export function notify(text: string, tone: "info" | "warn" | "error" = "info", ms = 5000): void {
  setState({ notice: { text, tone } });
  if (noticeTimer) clearTimeout(noticeTimer);
  if (ms > 0) noticeTimer = setTimeout(() => setState({ notice: null }), ms);
}
