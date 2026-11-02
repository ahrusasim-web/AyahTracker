import { useEffect, useState } from "react";
import fixWebmDuration from "fix-webm-duration";
import { median, pickRecordingType, RECORDING_BITRATE } from "../core/session/recording";
import { getState, loadSessions, notify, saveSession, setState, useApp } from "./store";

/**
 * Records the recitation while listening, on this phone only.
 *
 * The microphone stream the recogniser uses is also fed to a MediaRecorder (Opus, ~14 MB an
 * hour). Every few seconds the newest piece is written to IndexedDB, so an app that is closed or
 * killed mid-prayer loses at most those seconds; the pieces are joined into one file when
 * listening stops (or the next time the app opens). Recordings are kept with their sessions and
 * removed with them.
 */
export interface RecordingMeta {
  /** The session's startedAt. */
  id: number;
  mime: string;
  /** Wall-clock time the recording began (ms). */
  startedWall: number;
  durationMs: number;
  bytes: number;
  status: "recording" | "done";
  /** Level of the loud parts of speech (dBFS), for playback at a comfortable volume. */
  speechDb?: number;
  /** When the last piece was written (ms), to recover a recording that was never finished. */
  updatedWall: number;
}

const DB = "ayahlive-recordings";
const META = "meta";
const CHUNKS = "chunks";
const FILES = "files";
/** Each piece written to storage covers this much audio (ms). */
const TIMESLICE = 3000;

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore(META, { keyPath: "id" });
      d.createObjectStore(CHUNKS, { keyPath: ["id", "seq"] });
      d.createObjectStore(FILES);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      dbp = null;
      reject(r.error);
    };
  }));
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
  });
}

const chunkRange = (id: number) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
const bump = () => setState((s) => ({ recVersion: s.recVersion + 1 }));

export const recordingSupported =
  typeof MediaRecorder !== "undefined" && typeof indexedDB !== "undefined" && pickRecordingType((t) => MediaRecorder.isTypeSupported(t)) !== null;

interface Active {
  rec: MediaRecorder;
  meta: RecordingMeta;
  seq: number;
  writes: Promise<void>;
  levels: number[];
  failed: boolean;
  stopped: Promise<void>;
}
let active: Active | null = null;

/** Start recording the microphone stream for session `id`. Returns false if not recording. */
export async function startRecording(stream: MediaStream, id: number): Promise<boolean> {
  if (!getState().settings.record || !recordingSupported || active) return false;
  const mime = pickRecordingType((t) => MediaRecorder.isTypeSupported(t))!;
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: RECORDING_BITRATE });
  } catch {
    return false;
  }
  const now = Date.now();
  const a: Active = {
    rec,
    meta: { id, mime: rec.mimeType || mime, startedWall: now, durationMs: 0, bytes: 0, status: "recording", updatedWall: now },
    seq: 0,
    writes: Promise.resolve(),
    levels: [],
    failed: false,
    stopped: new Promise((resolve) => rec.addEventListener("stop", () => resolve(), { once: true })),
  };
  rec.addEventListener("start", () => (a.meta.startedWall = Date.now()), { once: true });
  rec.ondataavailable = (e) => {
    if (!e.data.size || a.failed) return;
    const seq = a.seq++;
    const blob = e.data;
    a.meta.bytes += blob.size;
    a.meta.updatedWall = Date.now();
    a.meta.durationMs = a.meta.updatedWall - a.meta.startedWall;
    const meta: RecordingMeta = { ...a.meta, speechDb: median(a.levels) };
    a.writes = a.writes
      .then(async () => {
        const d = await db();
        const tx = d.transaction([META, CHUNKS], "readwrite");
        tx.objectStore(CHUNKS).put({ id, seq, blob });
        tx.objectStore(META).put(meta);
        await done(tx);
      })
      .catch(() => {
        if (a.failed) return;
        a.failed = true;
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
        notify("Recording stopped: there isn't enough storage on this phone. Listening continues; what was recorded so far is kept.", "warn", 10000);
      });
  };
  try {
    const d = await db();
    const tx = d.transaction(META, "readwrite");
    tx.objectStore(META).put(a.meta);
    await done(tx);
    rec.start(TIMESLICE);
  } catch {
    return false;
  }
  active = a;
  // Ask the browser not to clear this site's storage when space runs low.
  void navigator.storage?.persist?.().catch(() => false);
  setState({ recording: { id, startedWall: a.meta.startedWall } });
  return true;
}

/** Loudness of speech heard while recording (from the recogniser's audio analysis). */
export function noteSpeechLevel(speechDb: number, speech: boolean): void {
  if (!active || !speech || !Number.isFinite(speechDb)) return;
  active.levels.push(speechDb);
  if (active.levels.length > 4000) active.levels = active.levels.filter((_, i) => i % 2 === 0);
}

export function isRecording(id?: number): boolean {
  return !!active && (id === undefined || active.meta.id === id);
}

/** Stop recording and save the finished file. Resolves when it is stored. */
export async function stopRecording(): Promise<RecordingMeta | null> {
  const a = active;
  if (!a) return null;
  active = null;
  setState({ recording: null });
  if (a.rec.state !== "inactive") {
    try {
      a.rec.stop();
    } catch {
      /* already stopped */
    }
    await Promise.race([a.stopped, new Promise((r) => setTimeout(r, 4000))]);
  }
  await a.writes;
  a.meta.durationMs = Math.max(a.meta.durationMs, Date.now() - a.meta.startedWall);
  if (a.failed) a.meta.durationMs = a.meta.updatedWall - a.meta.startedWall;
  a.meta.speechDb = median(a.levels);
  return finish(a.meta);
}

/** Join the stored pieces into one file with its duration written in (so it can be seeked). */
async function finish(meta: RecordingMeta): Promise<RecordingMeta | null> {
  const d = await db();
  const rows = (await req(d.transaction(CHUNKS).objectStore(CHUNKS).getAll(chunkRange(meta.id)))) as { seq: number; blob: Blob }[];
  if (!rows.length) {
    await deleteRecording(meta.id);
    return null;
  }
  rows.sort((x, y) => x.seq - y.seq);
  let file = new Blob(rows.map((r) => r.blob), { type: meta.mime });
  if (meta.mime.includes("webm")) {
    try {
      file = await fixWebmDuration(file, meta.durationMs, { logger: false });
    } catch {
      /* still playable, just without a known length */
    }
  }
  const finished: RecordingMeta = { ...meta, status: "done", bytes: file.size };
  const tx = d.transaction([META, CHUNKS, FILES], "readwrite");
  tx.objectStore(FILES).put(file, meta.id);
  tx.objectStore(META).put(finished);
  tx.objectStore(CHUNKS).delete(chunkRange(meta.id));
  await done(tx);
  bump();
  return finished;
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  try {
    const d = await db();
    return (await req(d.transaction(META).objectStore(META).getAll())) as RecordingMeta[];
  } catch {
    return [];
  }
}

export async function getRecordingMeta(id: number): Promise<RecordingMeta | null> {
  try {
    const d = await db();
    return ((await req(d.transaction(META).objectStore(META).get(id))) as RecordingMeta | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function getRecordingFile(id: number): Promise<Blob | null> {
  try {
    const d = await db();
    const f = await req(d.transaction(FILES).objectStore(FILES).get(id));
    return f instanceof Blob ? f : null;
  } catch {
    return null;
  }
}

export async function deleteRecording(id: number): Promise<void> {
  if (active?.meta.id === id) return;
  const d = await db();
  const tx = d.transaction([META, CHUNKS, FILES], "readwrite");
  tx.objectStore(META).delete(id);
  tx.objectStore(FILES).delete(id);
  tx.objectStore(CHUNKS).delete(chunkRange(id));
  await done(tx);
  bump();
}

export async function deleteAllRecordings(): Promise<void> {
  for (const m of await listRecordings()) await deleteRecording(m.id);
}

/** Remove recordings whose session is no longer kept (only the last few sessions are). */
export async function pruneRecordings(): Promise<void> {
  const kept = new Set(loadSessions().map((s) => s.startedAt));
  for (const m of await listRecordings()) if (!kept.has(m.id) && active?.meta.id !== m.id) await deleteRecording(m.id);
}

/**
 * At start-up: finish recordings that were cut off (the app was closed or killed while
 * listening), give each a session so it can be found, then drop recordings without a session.
 */
export async function initRecordings(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    for (const m of await listRecordings()) {
      if (m.status !== "recording" || active?.meta.id === m.id) continue;
      const finished = await finish({ ...m, durationMs: Math.max(m.durationMs, m.updatedWall - m.startedWall) });
      if (finished && !loadSessions().some((s) => s.startedAt === m.id)) {
        saveSession({ startedAt: m.id, prayer: "general", entries: [], recorded: true });
      }
    }
    await pruneRecordings();
  } catch {
    /* storage unavailable: nothing to recover */
  }
}

export async function recordingsSize(): Promise<number> {
  return (await listRecordings()).reduce((n, m) => n + m.bytes, 0);
}

/** The stored recording for a session: undefined while loading, null if there is none. */
export function useRecording(id: number): RecordingMeta | null | undefined {
  const version = useApp((s) => s.recVersion);
  const [meta, setMeta] = useState<RecordingMeta | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void getRecordingMeta(id).then((m) => live && setMeta(m));
    return () => {
      live = false;
    };
  }, [id, version]);
  return meta;
}
