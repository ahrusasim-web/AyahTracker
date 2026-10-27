import { useSyncExternalStore } from "react";
import type { PlaybackMode, PlaybackState } from "../core/playback/controller";
import type { LibraryStats } from "../core/playback/library";
import type { ConfirmVia, PrayerContext, Sensitivity, TrackerState, VerseRef } from "../core/types";

export interface Settings {
  prayer: PrayerContext;
  sensitivity: Sensitivity;
  playbackMode: PlaybackMode;
  autoTranslate: boolean;
  keepScreenOn: boolean;
  /** Translations play through the phone speaker: let the browser cancel them from the mic. */
  speakerMode: boolean;
  conditioning: boolean;
  /** Optional hosted translations folder, e.g. "translations/". */
  libraryUrl: string;
  mediaKeys: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  prayer: "general",
  sensitivity: "balanced",
  playbackMode: "follow",
  autoTranslate: true,
  keepScreenOn: true,
  speakerMode: false,
  conditioning: true,
  libraryUrl: "",
  mediaKeys: true,
};

export interface HistoryEntry {
  id: number;
  v: VerseRef;
  /** Wall-clock time the verse was confirmed (ms since epoch). */
  wall: number;
  via: ConfirmVia;
  ambiguousWith?: VerseRef[];
  late?: boolean;
}

export interface SavedSession {
  startedAt: number;
  prayer: PrayerContext;
  entries: HistoryEntry[];
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
}

const SETTINGS_KEY = "ayahlive.settings.v1";
const SESSIONS_KEY = "ayahlive.sessions.v1";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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

export function saveSession(s: SavedSession): void {
  if (!s.entries.length) return;
  try {
    const all = loadSessions().filter((x) => x.startedAt !== s.startedAt);
    all.unshift(s);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(all.slice(0, 12)));
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
