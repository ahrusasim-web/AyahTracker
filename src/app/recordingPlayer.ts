import { playbackGainDb } from "../core/session/recording";
import { playback, setMediaKeyTarget, updateMediaSession } from "./audio";
import { getRecordingFile, getRecordingMeta, type RecordingMeta } from "./recorder";
import { getState, notify, setState, type RecPlayState } from "./store";

/**
 * Plays a session's recording. One <audio> element, routed through a gain and a limiter so a
 * distant, quiet recording plays back at a comfortable level (the gain comes from the speech
 * level measured while recording). Starting it stops any translation; a translation started
 * from the app pauses it.
 */
const el = typeof Audio !== "undefined" ? new Audio() : (null as unknown as HTMLAudioElement);
let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let meta: RecordingMeta | null = null;
let url: string | null = null;
let loading: Promise<boolean> | null = null;

const idle: RecPlayState = { id: null, loading: false, playing: false, t: 0, duration: 0 };
const set = (p: Partial<RecPlayState>) => setState((s) => ({ recPlay: { ...s.recPlay, ...p } }));

function duration(): number {
  if (el && Number.isFinite(el.duration) && el.duration > 0) return el.duration;
  return meta ? meta.durationMs / 1000 : 0;
}

if (el) {
  el.preload = "auto";
  let lastTick = 0;
  el.addEventListener("timeupdate", () => {
    const now = performance.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    set({ t: el.currentTime });
  });
  el.addEventListener("loadedmetadata", () => set({ duration: duration() }));
  el.addEventListener("play", () => set({ playing: true }));
  el.addEventListener("pause", () => set({ playing: false, t: el.currentTime }));
  el.addEventListener("ended", () => set({ playing: false, t: duration() }));
  el.addEventListener("seeked", () => set({ t: el.currentTime }));
  // A translation started from the app (a tap on a verse) takes over.
  playback.subscribe((p) => {
    if (p.current && !el.paused) el.pause();
  });
}

function graph(): void {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    const src = ctx.createMediaElementSource(el);
    gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    src.connect(gain).connect(limiter).connect(ctx.destination);
  } catch {
    ctx = null; // plays at its recorded level
  }
}

/** Open a session's recording (does not start playing). */
export function loadRecording(id: number): Promise<boolean> {
  if (meta?.id === id && url) return Promise.resolve(true);
  if (loading && getState().recPlay.id === id) return loading;
  unloadRecording();
  set({ id, loading: true });
  loading = (async () => {
    const [m, file] = await Promise.all([getRecordingMeta(id), getRecordingFile(id)]);
    if (getState().recPlay.id !== id) return false; // closed meanwhile
    if (!m || !file) {
      set({ loading: false });
      return false;
    }
    meta = m;
    url = URL.createObjectURL(file);
    el.src = url;
    set({ loading: false, t: 0, duration: m.durationMs / 1000 });
    setMediaKeyTarget({ play: () => void playRecording(), pause: pauseRecording, seekBy: (s) => seekRecording(el.currentTime + s) });
    return true;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** Close the recording (leaving the session screen). */
export function unloadRecording(): void {
  if (el) {
    el.pause();
    el.removeAttribute("src");
    el.load();
  }
  if (url) URL.revokeObjectURL(url);
  if (meta && getState().listen === "idle") updateMediaSession("Ayah Live", false);
  url = null;
  meta = null;
  setMediaKeyTarget(null);
  set(idle);
}

export async function playRecording(): Promise<void> {
  if (!meta) return;
  if (getState().listen !== "idle") {
    notify("Stop listening first — the microphone would hear the recording.", "warn");
    return;
  }
  graph();
  if (gain) gain.gain.value = Math.pow(10, playbackGainDb(meta.speechDb) / 20);
  await ctx?.resume().catch(() => undefined);
  playback.stopAll();
  try {
    await el.play();
    const d = new Date(meta.id);
    updateMediaSession(`Recording · ${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`, false, "Ayah Live recording");
  } catch {
    notify("This recording can't be played in this browser.", "warn");
  }
}

export function pauseRecording(): void {
  el?.pause();
}

export function seekRecording(sec: number): void {
  if (!meta) return;
  el.currentTime = Math.max(0, Math.min(sec, Math.max(0, duration() - 0.2)));
  set({ t: el.currentTime });
}

/** Open session `id`'s recording and play it from `sec`. */
export async function playRecordingFrom(id: number, sec: number): Promise<void> {
  if (!(await loadRecording(id))) {
    notify("The recording of this session isn't on this phone any more.", "warn");
    return;
  }
  if (el.readyState < 1) await new Promise((r) => el.addEventListener("loadedmetadata", r, { once: true }));
  seekRecording(sec);
  await playRecording();
}
