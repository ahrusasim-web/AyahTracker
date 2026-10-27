import { describe, expect, it } from "vitest";
import { parseClipName, TranslationLibrary, UrlLibrary } from "./library";
import { PlaybackController, type ClipPlayer, type PlayItem } from "./controller";
import type { ConfirmedVerse } from "../types";

const src = (name: string) => ({ name, load: async () => name });

describe("translation file resolver", () => {
  it("parses ayah, padded ayah, surah and cue names", () => {
    expect(parseClipName("92-2.mp3")).toEqual({ kind: "ayah", s: 92, a: 2 });
    expect(parseClipName("92-02.mp3")).toEqual({ kind: "ayah", s: 92, a: 2 });
    expect(parseClipName("Library/114-06.MP3")).toEqual({ kind: "ayah", s: 114, a: 6 });
    expect(parseClipName("104.mp3")).toEqual({ kind: "surah", s: 104 });
    expect(parseClipName("assets/audio/start.mp3")).toEqual({ kind: "cue", cue: "start" });
    expect(parseClipName("1-8.mp3")).toEqual({ kind: "other" }); // Al-Fatihah has 7 verses
    expect(parseClipName("115.mp3")).toEqual({ kind: "other" });
    expect(parseClipName("29-11 (1).mp3")).toEqual({ kind: "other" });
  });

  it("resolves exactly and never falls back to another verse", () => {
    const lib = new TranslationLibrary();
    ["29-11.mp3", "92-02.mp3", "104.mp3"].forEach((n) => lib.add(src(n)));
    expect(lib.resolveAyah({ s: 29, a: 11 })?.name).toBe("29-11.mp3");
    expect(lib.resolveAyah({ s: 92, a: 2 })?.name).toBe("92-02.mp3");
    expect(lib.resolveAyah({ s: 29, a: 12 })).toBeNull();
    expect(lib.resolveAyah({ s: 104, a: 1 })).toBeNull(); // a whole-surah file is not an ayah file
    expect(lib.resolveSurah(104)?.name).toBe("104.mp3");
    expect(lib.resolveSurah(29)).toBeNull();
  });

  it("prefers the unpadded name deterministically when both exist", () => {
    const a = new TranslationLibrary();
    a.add(src("92-02.mp3"));
    a.add(src("92-2.mp3"));
    const b = new TranslationLibrary();
    b.add(src("92-2.mp3"));
    b.add(src("92-02.mp3"));
    expect(a.resolveAyah({ s: 92, a: 2 })?.name).toBe("92-2.mp3");
    expect(b.resolveAyah({ s: 92, a: 2 })?.name).toBe("92-2.mp3");
    expect(a.stats().duplicates).toEqual(["92-02.mp3"]);
  });

  it("probes hosted names in a fixed order", async () => {
    const hits = new Set(["https://x/t/92-02.mp3"]);
    const asked: string[] = [];
    const fetcher = (async (u: string) => {
      asked.push(u);
      return new Response(null, { status: hits.has(u) ? 200 : 404, headers: { "content-type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const lib = new UrlLibrary("https://x/t", fetcher);
    expect(await lib.resolveAyah({ s: 92, a: 2 })).toBe("https://x/t/92-02.mp3");
    expect(asked).toEqual(["https://x/t/92-2.mp3", "https://x/t/92-02.mp3"]);
    expect(await lib.resolveAyah({ s: 92, a: 3 })).toBeNull();
  });
});

class FakePlayer implements ClipPlayer {
  log: string[] = [];
  private resolve: ((r: "ended" | "stopped") => void) | null = null;
  play(item: PlayItem) {
    this.log.push(`${item.kind}:${item.v.s}:${item.v.a}${item.manual ? "m" : ""}`);
    return new Promise<"ended" | "stopped">((r) => (this.resolve = r));
  }
  end() { const r = this.resolve; this.resolve = null; r?.("ended"); return new Promise((ok) => setTimeout(ok, 0)); }
  stop() { const r = this.resolve; this.resolve = null; r?.("stopped"); }
  pause() {}
  resume() {}
}
let id = 1;
const entry = (s: number, a: number, extra: Partial<ConfirmedVerse> = {}): ConfirmedVerse => ({ id: id++, v: { s, a }, t: 0, via: "continuation", segment: 0, ...extra });
const tick = () => new Promise((ok) => setTimeout(ok, 0));

describe("playback policy", () => {
  it("Follow Live keeps at most one clip waiting and plays the newest", async () => {
    const p = new FakePlayer();
    const c = new PlaybackController(p, "follow");
    c.onConfirmed(entry(55, 1));
    c.onConfirmed(entry(55, 2));
    c.onConfirmed(entry(55, 3));
    c.onConfirmed(entry(55, 4));
    await tick();
    await p.end();
    await p.end();
    expect(p.log).toEqual(["ayah:55:1", "ayah:55:4"]);
    expect(c.state.skipped).toBe(2);
  });

  it("Sequential plays every verse once, in order", async () => {
    const p = new FakePlayer();
    const c = new PlaybackController(p, "sequential");
    const e = entry(77, 27);
    c.onConfirmed(e);
    c.onConfirmed(e); // duplicate trigger for the same entry
    c.onConfirmed(entry(77, 28));
    c.onConfirmed(entry(77, 29));
    await tick();
    await p.end(); await p.end(); await p.end();
    expect(p.log).toEqual(["ayah:77:27", "ayah:77:28", "ayah:77:29"]);
  });

  it("a repeated verse is a new entry and plays again; muted auto-play plays nothing", async () => {
    const p = new FakePlayer();
    const c = new PlaybackController(p, "sequential");
    c.onConfirmed(entry(1, 7));
    await tick(); await p.end();
    c.onConfirmed(entry(1, 7));
    await tick(); await p.end();
    expect(p.log).toEqual(["ayah:1:7", "ayah:1:7"]);
    c.autoPlay = false;
    c.onConfirmed(entry(1, 1));
    await tick();
    expect(p.log.length).toBe(2);
  });

  it("manual replay interrupts, then auto playback resumes with the newest clip", async () => {
    const p = new FakePlayer();
    const c = new PlaybackController(p, "follow");
    c.onConfirmed(entry(104, 1));
    await tick();
    c.playManual(99, { s: 104, a: 0 }, "surah");
    await tick();
    c.onConfirmed(entry(104, 2));
    await p.end(); // manual ends
    await p.end();
    expect(p.log).toEqual(["ayah:104:1", "surah:104:0m", "ayah:104:2"]);
  });

  it("late entries are not auto-played in Follow Live", async () => {
    const p = new FakePlayer();
    const c = new PlaybackController(p, "follow");
    c.onConfirmed(entry(36, 5, { late: true }));
    await tick();
    expect(p.log).toEqual([]);
  });
});
