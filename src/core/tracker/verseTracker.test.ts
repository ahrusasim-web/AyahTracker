import { describe, expect, it } from "vitest";
import { VerseTracker } from "./verseTracker";
import type { Observation, TrackerEvent, VerseRef } from "../types";
import { quranIndex } from "../quran/quranIndex";

const v = (s: number, a: number): VerseRef => ({ s, a });
let clock = 0;
const match = (s: number, a: number): Observation => ({ kind: "match", t: (clock += 1), v: v(s, a), confidence: 0.6 });
const prog = (s: number, a: number, matched: number): Observation => ({
  kind: "progress",
  t: (clock += 0.3),
  v: v(s, a),
  wordIndex: matched,
  totalWords: quranIndex.words(v(s, a)),
  matched: Array.from({ length: matched }, (_, i) => i),
});
const act = (): Observation => ({ kind: "activity", t: (clock += 0.1) });
const seg = (pause = 5): Observation => ({ kind: "segment", t: (clock += pause) });

function run(t: VerseTracker, obs: Observation[]): TrackerEvent[] {
  return obs.flatMap((o) => t.observe(o));
}
const confirmed = (evs: TrackerEvent[]) =>
  evs.filter((e): e is Extract<TrackerEvent, { type: "confirmed" }> => e.type === "confirmed").map((e) => `${e.entry.v.s}:${e.entry.v.a}`);

describe("VerseTracker", () => {
  it("confirms a discovered verse and its continuation", () => {
    const t = new VerseTracker();
    const evs = run(t, [act(), match(77, 1), prog(77, 2, 1), match(77, 2), prog(77, 3, 1), match(77, 3)]);
    expect(confirmed(evs)).toEqual(["77:1", "77:2", "77:3"]);
  });

  it("on course, confirms the next verse on its first heard word — never from zero words", () => {
    const t = new VerseTracker();
    run(t, [act(), match(2, 255)]);
    expect(confirmed(run(t, [prog(2, 256, 0)]))).toEqual([]);
    expect(confirmed(run(t, [prog(2, 256, 1)]))).toEqual(["2:256"]);
    // the recogniser's later gate for the same verse is not a second confirmation
    expect(confirmed(run(t, [match(2, 256)]))).toEqual([]);
  });

  it("needs a confident first word, not just an aligned one", () => {
    const t = new VerseTracker();
    run(t, [act(), match(2, 255)]);
    // a later word confident but the opening word not: wait for more of the verse
    const weakOpening: Observation = { ...prog(2, 256, 1), evidence: { heard: 1, strong: 1, wrong: 1, first: false } } as Observation;
    expect(confirmed(run(t, [weakOpening]))).toEqual([]);
    const strongOpening: Observation = { ...prog(2, 256, 1), evidence: { heard: 1, strong: 1, wrong: 0, first: true } } as Observation;
    expect(confirmed(run(t, [strongOpening]))).toEqual(["2:256"]);
  });

  it("fills in a verse the recogniser skipped between two confirmed neighbours", () => {
    const t = new VerseTracker();
    run(t, [act(), match(102, 1), match(102, 2)]);
    const evs = run(t, [match(102, 4)]);
    expect(confirmed(evs)).toEqual(["102:3", "102:4"]);
    const inferred = evs.find((e) => e.type === "confirmed" && e.entry.via === "inferred");
    expect(inferred).toBeTruthy();
  });

  it("hears Al-Fatihah again after a pause (second rak'ah)", () => {
    const t = new VerseTracker({ prayer: "maghrib" });
    const fat = (): Observation[] => [act(), prog(1, 2, 2), match(1, 2), match(1, 3), match(1, 4), match(1, 5), match(1, 6), match(1, 7)];
    const evs = run(t, [...fat(), seg(30), ...fat()]);
    expect(confirmed(evs)).toEqual(["1:2", "1:3", "1:4", "1:5", "1:6", "1:7", "1:2", "1:3", "1:4", "1:5", "1:6", "1:7"]);
  });

  it("holds the basmala until Al-Fatihah continues, and drops it when a surah follows", () => {
    const t = new VerseTracker();
    let evs = run(t, [act(), match(1, 1)]);
    expect(confirmed(evs)).toEqual([]);
    evs = run(t, [prog(1, 2, 1)]);
    expect(confirmed(evs)).toEqual(["1:1", "1:2"]);

    const u = new VerseTracker();
    evs = run(u, [act(), match(1, 1), prog(91, 1, 2), match(91, 1)]);
    expect(confirmed(evs)).toEqual(["91:1"]);
    expect(evs.some((e) => e.type === "dropped")).toBe(true);
  });

  it("places identical Ar-Rahman refrains by sequence", () => {
    const t = new VerseTracker();
    run(t, [act(), match(55, 11), match(55, 12)]);
    // the recogniser proposes the refrain at a different location: context puts it at 55:13
    const evs = run(t, [match(55, 16)]);
    expect(confirmed(evs)).toEqual(["55:13"]);
  });

  it("confirms an identical verse without context as ambiguous, then revises it", () => {
    const t = new VerseTracker();
    const evs = run(t, [act(), match(55, 40)]);
    const c = evs.find((e) => e.type === "confirmed") as Extract<TrackerEvent, { type: "confirmed" }>;
    expect(c.entry.ambiguousWith?.length).toBe(30);
    // the recogniser's pick was right: the next verse settles it without a revision
    const later = run(t, [prog(55, 41, 3), match(55, 41)]);
    expect(later.find((e) => e.type === "revised")).toBeUndefined();
    // a wrong pick is revised once the next verse arrives
    const u = new VerseTracker();
    run(u, [act(), match(55, 13)]);
    const ev2 = run(u, [prog(55, 41, 3), match(55, 41)]);
    expect(ev2.find((e) => e.type === "revised")).toMatchObject({ v: v(55, 40), previous: v(55, 13) });
  });

  it("holds a mid-passage jump and drops it when the recogniser returns", () => {
    const t = new VerseTracker();
    run(t, [act(), match(36, 1), match(36, 2), match(36, 3)]);
    let evs = run(t, [match(10, 5)]);
    expect(confirmed(evs)).toEqual([]);
    evs = run(t, [match(36, 4)]);
    expect(confirmed(evs)).toEqual(["36:4"]);
    expect(evs.some((e) => e.type === "dropped")).toBe(true);
  });

  it("accepts a mid-passage jump once the next verse corroborates it", () => {
    const t = new VerseTracker();
    run(t, [act(), match(36, 1), match(36, 2), match(36, 3)]);
    const evs = run(t, [match(67, 1), prog(67, 2, 1)]);
    expect(confirmed(evs)).toEqual(["67:1", "67:2"]);
  });

  it("resolves a held 'Ha Mim' to the surah that continues", () => {
    const t = new VerseTracker();
    let evs = run(t, [act(), match(40, 1)]);
    expect(confirmed(evs)).toEqual([]);
    evs = run(t, [prog(44, 2, 1)]);
    expect(confirmed(evs)).toEqual(["44:1", "44:2"]);
  });

  it("holds a short discovered verse until all of it is heard (general), but not when favoured (Maghrib)", () => {
    const g = new VerseTracker({ prayer: "general" });
    expect(confirmed(run(g, [act(), match(103, 1)]))).toEqual([]);
    expect(confirmed(run(g, [prog(103, 1, 1)]))).toEqual(["103:1"]);

    const m = new VerseTracker({ prayer: "maghrib" });
    expect(confirmed(run(m, [act(), match(103, 1)]))).toEqual(["103:1"]);
  });

  it("never confirms anything from activity alone", () => {
    const t = new VerseTracker();
    const evs = run(t, Array.from({ length: 50 }, act));
    expect(confirmed(evs)).toEqual([]);
  });

  it("holds a continuation heard only through noise, confirming it once a confident verse follows", () => {
    const weak = { heard: 2, strong: 0, wrong: 0 };
    const strong = { heard: 2, strong: 2, wrong: 0 };
    const m = (s: number, a: number, evidence: typeof weak): Observation => ({ kind: "match", t: (clock += 1), v: v(s, a), confidence: 0.6, evidence });
    const t = new VerseTracker();
    run(t, [act(), m(70, 1, strong), m(70, 2, strong)]);
    expect(confirmed(run(t, [m(70, 3, weak)]))).toEqual([]);
    expect(confirmed(run(t, [m(70, 4, strong)]))).toEqual(["70:3", "70:4"]);
  });

  it("drops continuations aligned to noise after the imam stops", () => {
    const weak = { heard: 2, strong: 0, wrong: 1 };
    const strong = { heard: 3, strong: 2, wrong: 0 };
    const m = (s: number, a: number, evidence: typeof weak): Observation => ({ kind: "match", t: (clock += 1), v: v(s, a), confidence: 0.6, evidence });
    const t = new VerseTracker();
    run(t, [act(), m(90, 5, strong), m(90, 6, strong)]);
    const evs = run(t, [m(90, 7, weak), m(90, 8, weak), seg(12)]);
    expect(confirmed(evs)).toEqual([]);
    expect(evs.filter((e) => e.type === "dropped").length).toBe(2);
  });

  it("completes a surah whose last verse was recited but not recognised", () => {
    const t = new VerseTracker();
    run(t, [act(), match(102, 5), match(102, 6), match(102, 7)]);
    // the imam carries on reciting (102:8, unrecognised), then pauses for ruku'
    const evs = run(t, [...Array.from({ length: 40 }, act), seg()]);
    expect(confirmed(evs)).toEqual(["102:8"]);
    expect(evs.find((e) => e.type === "confirmed")).toMatchObject({ entry: { via: "completed" } });
  });

  it("does not complete a surah when the recitation stopped at the last verse heard", () => {
    const t = new VerseTracker();
    run(t, [act(), match(102, 5), match(102, 6), match(102, 7)]);
    expect(confirmed(run(t, [act(), act(), seg()]))).toEqual([]);
  });

  it("never completes a long ending, or a passage stopped well before the end", () => {
    const t = new VerseTracker();
    run(t, [act(), match(2, 281), match(2, 282), match(2, 283)]); // 2:284–286 is far more than a few words
    expect(confirmed(run(t, [...Array.from({ length: 300 }, act), seg()]))).toEqual([]);
    const u = new VerseTracker();
    run(u, [act(), match(91, 3), match(91, 4), match(91, 5)]); // ten verses left
    expect(confirmed(run(u, [...Array.from({ length: 300 }, act), seg()]))).toEqual([]);
  });

  it("completes the surah when listening stops just after it", () => {
    const t = new VerseTracker();
    run(t, [act(), match(102, 5), match(102, 6), match(102, 7), ...Array.from({ length: 40 }, act)]);
    expect(confirmed(t.finish())).toEqual(["102:8"]);
  });

  it("completes Al-Fatihah when the recitation moves on to a surah", () => {
    const t = new VerseTracker();
    run(t, [act(), match(1, 2), match(1, 3), match(1, 4), match(1, 5), ...Array.from({ length: 60 }, act)]);
    const evs = run(t, [match(108, 1), match(108, 2)]);
    expect(confirmed(evs)).toEqual(["1:6", "1:7", "108:1", "108:2"]);
  });

  it("fills in a surah's opening missed straight after Al-Fatihah, but not without Al-Fatihah", () => {
    const t = new VerseTracker();
    run(t, [act(), match(1, 5), match(1, 6), match(1, 7), ...Array.from({ length: 80 }, act)]);
    expect(confirmed(run(t, [match(69, 2), match(69, 3)]))).toEqual(["69:1", "69:2", "69:3"]);
    const u = new VerseTracker();
    expect(confirmed(run(u, [act(), ...Array.from({ length: 80 }, act), match(69, 2), match(69, 3)]))).toEqual(["69:2", "69:3"]);
  });

  it("fills several verses missed mid-passage once the recogniser finds its place again", () => {
    const t = new VerseTracker();
    run(t, [act(), match(36, 1), match(36, 2)]);
    const evs = run(t, [...Array.from({ length: 90 }, act), match(36, 6)]);
    expect(confirmed(evs)).toEqual(["36:3", "36:4", "36:5", "36:6"]);
    expect(evs.filter((e) => e.type === "confirmed" && e.entry.via === "inferred").length).toBe(3);
  });

  it("holds a jump ahead that comes too soon for the verses between to have been recited", () => {
    const t = new VerseTracker();
    run(t, [act(), match(36, 1), match(36, 2)]);
    expect(confirmed(run(t, [match(36, 6)]))).toEqual([]);
  });

  it("does not re-confirm verses found again after a restart inside noisy recitation", () => {
    const t = new VerseTracker();
    run(t, [act(), match(1, 2), match(1, 3), match(1, 4), match(1, 5)]);
    const evs = run(t, [{ kind: "segment", t: (clock += 7), silent: false }, act(), match(1, 4), match(1, 5), match(1, 6)]);
    expect(confirmed(evs)).toEqual(["1:6"]);
  });
});

