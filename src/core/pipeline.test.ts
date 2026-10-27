import { describe, expect, it } from "vitest";
import { RecognitionPipeline } from "./pipeline";
import type { Recognizer } from "./engine/recognizer";
import type { Observation, VerseRef } from "./types";

/** A scripted recogniser: per 320 ms chunk index, the observations it would produce. */
class Scripted implements Recognizer {
  readonly name = "scripted";
  activityCount = 0;
  resets = 0;
  hints: (VerseRef | null)[] = [];
  private i = 0;
  constructor(private script: Map<number, Omit<Observation, "t">[]>) {}
  async feed(_pcm: Float32Array, t: number): Promise<Observation[]> {
    const obs = (this.script.get(this.i++) ?? []).map((o) => ({ ...o, t }) as Observation);
    if (obs.some((o) => o.kind === "activity")) this.activityCount++;
    return obs;
  }
  reset() { this.resets++; }
  setHint(v: VerseRef | null) { this.hints.push(v); }
}

const chunk = new Float32Array(5120);

describe("RecognitionPipeline", () => {
  it("resets the recogniser after a pause and hears a repeated verse again", async () => {
    const said = (s: number, a: number): Omit<Observation, "t">[] => [{ kind: "activity" }, { kind: "match", v: { s, a }, confidence: 0.6 }];
    const script = new Map<number, Omit<Observation, "t">[]>([
      [2, said(1, 2)],
      [4, said(1, 3)],
      // ~20 chunks (6.4 s) of silence: a new segment
      [26, said(1, 2)],
      [28, said(1, 3)],
    ]);
    const rec = new Scripted(script);
    const p = new RecognitionPipeline(rec, { tracker: { prayer: "isha" } });
    const confirmed: string[] = [];
    let segments = 0;
    for (let i = 0; i < 32; i++) {
      for (const e of await p.push(chunk)) {
        if (e.type === "confirmed") confirmed.push(`${e.entry.v.s}:${e.entry.v.a}`);
        if (e.type === "segment") segments++;
      }
    }
    expect(rec.resets).toBe(1);
    expect(segments).toBe(1);
    expect(rec.hints).toEqual([{ s: 1, a: 4 }]);
    expect(confirmed).toEqual(["1:2", "1:3", "1:2", "1:3"]);
  });

  it("does not reset repeatedly through a long silence", async () => {
    const rec = new Scripted(new Map([[1, [{ kind: "activity" } as Omit<Observation, "t">]]]));
    const p = new RecognitionPipeline(rec);
    for (let i = 0; i < 100; i++) await p.push(chunk);
    expect(rec.resets).toBe(1);
  });

  it("resets when crowd murmur keeps tokens coming but nothing is confidently heard", async () => {
    const strong = { heard: 3, strong: 2, wrong: 0 };
    const script = new Map<number, Omit<Observation, "t">[]>();
    script.set(1, [{ kind: "activity" }, { kind: "match", v: { s: 1, a: 7 }, confidence: 0.6, evidence: strong }]);
    for (let i = 2; i < 40; i++) script.set(i, [{ kind: "activity" }]); // murmur: tokens, no evidence
    const rec = new Scripted(script);
    const p = new RecognitionPipeline(rec, { tracker: { prayer: "isha" } });
    let segments = 0;
    for (let i = 0; i < 40; i++) for (const e of await p.push(chunk)) if (e.type === "segment") segments++;
    expect(segments).toBe(1); // ~7 s after the last confident word, once
  });
});

