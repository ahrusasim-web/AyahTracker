import type { PipelineEvent } from "../core/pipeline";
import type { ConfirmedVerse } from "../core/types";
import { quranIndex } from "../core/quran/quranIndex";
import { installMediaSession, playCue, playback, prefetchClip, setKeepAlive, updateMediaSession } from "./audio";
import { prefetchSurah } from "./translationText";
import { getState, notify, saveSession, setState, type HistoryEntry } from "./store";
import type { EngineSettings, FromWorker, ToWorker } from "./worker/protocol";

/**
 * Owns the microphone, the AudioWorklet, the recognition worker, the wake lock and the
 * media session. Listening state is separate from translation playback state: earbud
 * play/pause always means "toggle listening", whatever is or isn't playing.
 */
const base = document.baseURI;
let worker: Worker | null = null;
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let node: AudioWorkletNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let wakeLock: WakeLockSentinel | null = null;
let startWall = 0;
let wantListening = false;

const send = (m: ToWorker, transfer: Transferable[] = []) => worker?.postMessage(m, transfer);

function engineSettings(): EngineSettings {
  const s = getState().settings;
  return { prayer: s.prayer, sensitivity: s.sensitivity, conditioning: s.conditioning };
}

export function pushEngineSettings(): void {
  send({ type: "settings", settings: engineSettings() });
}

export function initEngine(): void {
  if (worker) return;
  worker = new Worker(new URL("./worker/recognition.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onWorker(e.data);
  worker.onerror = (e) => setState({ engine: { status: "error", progress: 0, detail: "", error: e.message || "The recognition worker failed to start." } });
  send({ type: "init", baseUrl: base, settings: engineSettings() });
  installMediaSession(() => void toggleListening());
  updateMediaSession("Ayah Live", false);
}

let lastBacklogWarn = 0;
const loadParts: Record<string, { loaded: number; total: number }> = {};

function onWorker(m: FromWorker): void {
  switch (m.type) {
    case "loading": {
      loadParts[m.stage] = { loaded: m.loaded, total: m.total || m.loaded };
      const tot = Object.values(loadParts).reduce((a, p) => a + p.total, 0);
      const got = Object.values(loadParts).reduce((a, p) => a + p.loaded, 0);
      const mb = (n: number) => (n / 1048576).toFixed(0);
      const detail = m.stage === "model" && !m.cached ? `Downloading the recogniser (${mb(m.loaded)} of ${mb(m.total || 69e6)} MB) — once only` : "Loading the recogniser";
      setState((s) => ({ engine: { ...s.engine, status: "loading", progress: tot ? got / tot : 0, detail } }));
      break;
    }
    case "ready":
      setState({ engine: { status: "ready", progress: 1, detail: "Ready", threads: m.threads } });
      break;
    case "error":
      if (m.fatal) setState({ engine: { status: "error", progress: 0, detail: "", error: m.message } });
      else notify(`Recognition error: ${m.message}`, "warn");
      break;
    case "stats":
      setState((s) => ({ engine: { ...s.engine, rtf: m.rtf, backlogSec: m.backlogSec } }));
      if (m.backlogSec > 6 && Date.now() - lastBacklogWarn > 60000) {
        lastBacklogWarn = Date.now();
        notify("This phone is falling behind the recitation. Close other apps or use a faster device.", "warn", 8000);
      }
      break;
    case "events":
      for (const ev of m.events) onEvent(ev);
      break;
    case "stopped":
      break;
  }
}

function toEntry(e: ConfirmedVerse): HistoryEntry {
  return { id: e.id, v: e.v, wall: startWall + e.t * 1000, via: e.via, ambiguousWith: e.ambiguousWith, late: e.late };
}

/** Late entries (confirmed after the verse that follows them) go before that verse. */
function insertInOrder(history: HistoryEntry[], e: HistoryEntry): HistoryEntry[] {
  if (!e.late) return [...history, e];
  const at = history.findLastIndex((h) => h.v.s === e.v.s && h.v.a === e.v.a + 1);
  if (at < 0) return [...history, e];
  return [...history.slice(0, at), { ...e, wall: Math.min(e.wall, history[at]!.wall) }, ...history.slice(at)];
}

function title(v: { s: number; a: number }): string {
  return `${quranIndex.surah(v.s)?.nameEn ?? "Surah " + v.s} ${v.s}:${v.a}`;
}

function onEvent(ev: PipelineEvent): void {
  switch (ev.type) {
    case "confirmed": {
      const entry = toEntry(ev.entry);
      setState((s) => ({
        history: insertInOrder(s.history, entry),
        tentative: s.tentative && s.tentative.v.s === entry.v.s && s.tentative.v.a === entry.v.a ? null : s.tentative,
      }));
      playback.onConfirmed(ev.entry);
      prefetchSurah(entry.v.s); // the passage summary's English text, ready by the time it ends
      const nextV = quranIndex.next(entry.v);
      if (nextV) prefetchClip(nextV); // the next verse's translation, ready the moment it's confirmed
      updateMediaSession(title(entry.v), true);
      persist();
      break;
    }
    case "revised":
      setState((s) => ({ history: s.history.map((h) => (h.id === ev.id ? { ...h, v: ev.v, ambiguousWith: undefined } : h)) }));
      playback.onRevised(ev.id, ev.v);
      persist();
      break;
    case "tentative":
      setState({ tentative: ev.v ? { v: ev.v, progress: ev.progress, matchedWords: ev.matchedWords, totalWords: ev.totalWords, reason: ev.reason } : null });
      break;
    case "state":
      setState({ tracker: ev.state });
      break;
    case "quality":
      setState({ quality: { snrDb: ev.quality.snrDb, levelDb: ev.quality.levelDb, gainDb: ev.quality.gainDb, speech: ev.quality.speech } });
      break;
    default:
      break;
  }
}

function persist(): void {
  const s = getState();
  if (s.sessionStartedAt) saveSession({ startedAt: s.sessionStartedAt, prayer: s.settings.prayer, entries: s.history });
}

async function acquireWakeLock(): Promise<void> {
  if (!getState().settings.keepScreenOn || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => (wakeLock = null));
  } catch {
    /* not allowed right now (e.g. battery saver) */
  }
}

function micErrorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "Microphone access is blocked. Allow it for this site in the browser's site settings, then try again.";
  if (name === "NotFoundError") return "No microphone was found on this device.";
  if (name === "NotReadableError") return "The microphone is in use by another app. Close it and try again.";
  return "Could not start the microphone: " + (err instanceof Error ? err.message : String(err));
}

export async function startListening(): Promise<void> {
  const s = getState();
  if (s.listen !== "idle") return;
  if (s.engine.status !== "ready") {
    notify(s.engine.status === "error" ? "The recogniser failed to load. Reload the page to try again." : "Still loading the recogniser — listening will be available in a moment.", "warn");
    return;
  }
  wantListening = true;
  setState({ listen: "starting" });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: s.settings.speakerMode,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext({ latencyHint: "interactive" });
      await ctx.audioWorklet.addModule(new URL("capture-worklet.js", base).href);
    }
    if (ctx.state !== "running") await ctx.resume();
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "ayah-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(ctx.destination);
    const ch = new MessageChannel();
    node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    send({ type: "audio-port", port: ch.port2 }, [ch.port2]);
    send({ type: "settings", settings: engineSettings() });
    send({ type: "start", sampleRate: ctx.sampleRate });
    startWall = Date.now();
    for (const t of stream.getAudioTracks()) t.addEventListener("ended", onTrackEnded);
    playback.resetSession();
    setState({ listen: "listening", history: [], tentative: null, tracker: "listening", sessionStartedAt: startWall });
    void playCue("start");
    setKeepAlive(true);
    updateMediaSession("Listening", true);
    void acquireWakeLock();
  } catch (err) {
    teardown();
    wantListening = false;
    setState({ listen: "idle" });
    notify(micErrorText(err), "error", 10000);
  }
}

function teardown(): void {
  try {
    source?.disconnect();
    node?.disconnect();
  } catch {
    /* already disconnected */
  }
  stream?.getTracks().forEach((t) => {
    t.removeEventListener("ended", onTrackEnded);
    t.stop();
  });
  stream = null;
  source = null;
  node = null;
  void ctx?.suspend().catch(() => undefined);
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
}

export async function stopListening(): Promise<void> {
  if (getState().listen !== "listening") return;
  wantListening = false;
  setState({ listen: "stopping" });
  send({ type: "stop" });
  teardown();
  persist();
  setKeepAlive(false);
  setState({ listen: "idle", tentative: null, tracker: "listening" });
  void playCue("stop");
  updateMediaSession("Stopped", false);
}

export async function toggleListening(): Promise<void> {
  const p = getState().listen;
  if (p === "listening") await stopListening();
  else if (p === "idle") await startListening();
  // starting/stopping: ignore the extra press
}

function onTrackEnded(): void {
  // The system took the microphone (a call, another app, or the browser suspending the tab).
  if (!wantListening) return;
  teardown();
  setState({ listen: "idle", tentative: null });
  setKeepAlive(false);
  updateMediaSession("Stopped", false);
  notify("The microphone was taken away by the system. Tap Start listening to continue.", "warn", 0);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (getState().listen === "listening") {
    if (!wakeLock) void acquireWakeLock();
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => undefined);
    const live = stream?.getAudioTracks().some((t) => t.readyState === "live");
    if (!live) onTrackEnded();
  }
});
