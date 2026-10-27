import { PlaybackController, type ClipPlayer, type PlayItem } from "../core/playback/controller";
import { resolveAyahClip, resolveCue, resolveSurahClip } from "./library";
import { getState, setState } from "./store";

const base = document.baseURI;

/** One <audio> element for translations, so two clips can never overlap. */
class ElementPlayer implements ClipPlayer {
  private el = new Audio();
  private url: string | null = null;
  private finish: ((r: "ended" | "stopped" | "missing" | "error") => void) | null = null;

  constructor() {
    this.el.preload = "auto";
    this.el.addEventListener("ended", () => this.done("ended"));
    this.el.addEventListener("error", () => this.done("error"));
  }

  private done(r: "ended" | "stopped" | "missing" | "error"): void {
    const f = this.finish;
    this.finish = null;
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    f?.(r);
  }

  async play(item: PlayItem): Promise<"ended" | "stopped" | "missing" | "error"> {
    const src = item.kind === "surah" ? await resolveSurahClip(item.v.s) : await resolveAyahClip(item.v);
    if (!src) return "missing";
    return new Promise((resolve) => {
      this.finish = resolve;
      if (typeof src === "string") this.el.src = src;
      else {
        this.url = URL.createObjectURL(src);
        this.el.src = this.url;
      }
      this.el.currentTime = 0;
      this.el.play().catch(() => this.done("error"));
    });
  }

  stop(): void {
    this.el.pause();
    this.done("stopped");
  }
  pause(): void {
    this.el.pause();
  }
  resume(): void {
    void this.el.play().catch(() => undefined);
  }
}

export const playback = new PlaybackController(new ElementPlayer(), getState().settings.playbackMode);
playback.autoPlay = getState().settings.autoTranslate;
playback.subscribe((p) => setState({ playback: p }));

// --- listening cues ---------------------------------------------------------------------

const cueEl = new Audio();
let lastCue = 0;
/** Plays start.mp3 / stop.mp3: from the user's library if present, else the bundled ones. */
export async function playCue(c: "start" | "stop"): Promise<void> {
  const now = performance.now();
  if (now - lastCue < 400) return; // swallow double triggers from repeated taps
  lastCue = now;
  try {
    const mine = await resolveCue(c);
    const src = mine ? (typeof mine === "string" ? mine : URL.createObjectURL(mine)) : new URL(`assets/audio/${c}.mp3`, base).href;
    cueEl.src = src;
    await cueEl.play();
  } catch {
    /* cue is optional */
  }
}

// --- media session: earbud play/pause toggles listening ------------------------------------

/**
 * Chrome only routes hardware media keys to a page that is playing media. While listening we
 * keep a near-silent loop playing (a few seconds of -70 dB noise) so the session stays active;
 * this is what makes earbud play/pause reach the app, and it also keeps Chrome from treating
 * the tab as idle. It is stopped as soon as listening stops.
 */
let keepAlive: HTMLAudioElement | null = null;
function keepAliveUrl(): string {
  const sr = 8000, n = sr * 4;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * 10), true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export function setKeepAlive(on: boolean): void {
  if (on) {
    if (!keepAlive) {
      keepAlive = new Audio(keepAliveUrl());
      keepAlive.loop = true;
      keepAlive.volume = 0.05;
    }
    void keepAlive.play().catch(() => undefined);
  } else keepAlive?.pause();
}

export function installMediaSession(toggle: () => void): boolean {
  if (!("mediaSession" in navigator)) return false;
  const ms = navigator.mediaSession;
  const handler = () => {
    if (getState().settings.mediaKeys) toggle();
  };
  for (const action of ["play", "pause", "stop"] as MediaSessionAction[]) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      /* action not supported */
    }
  }
  try {
    ms.setActionHandler("nexttrack", () => playback.skip());
  } catch {
    /* not supported */
  }
  return true;
}

export function updateMediaSession(title: string, listening: boolean): void {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: listening ? "Listening — press play/pause to stop" : "Stopped — press play/pause to listen",
      album: "Ayah Live",
      artwork: [{ src: new URL("icons/icon-512.png", base).href, sizes: "512x512", type: "image/png" }],
    });
    navigator.mediaSession.playbackState = listening ? "playing" : "paused";
  } catch {
    /* ignore */
  }
}
