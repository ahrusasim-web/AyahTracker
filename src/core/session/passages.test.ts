import { describe, expect, it } from "vitest";
import { buildPassages, rangeLabel } from "./passages";

let id = 0;
const e = (s: number, a: number, wall: number, late = false) => ({ id: ++id, v: { s, a }, wall, late });

describe("buildPassages", () => {
  it("splits a two-rak'ah salah into Fatihah and surah passages", () => {
    const t = 1_000_000;
    const entries = [
      ...[1, 2, 3, 4, 5, 6, 7].map((a, i) => e(1, a, t + i * 5000)),
      ...[1, 2, 3, 4].map((a, i) => e(67, a, t + 40_000 + i * 6000)),
      ...[1, 2, 3, 4, 5, 6, 7].map((a, i) => e(1, a, t + 120_000 + i * 5000)),
      ...[1, 2, 3].map((a, i) => e(103, a, t + 160_000 + i * 4000)),
    ];
    const ps = buildPassages(entries);
    expect(ps.map(rangeLabel)).toEqual(["1:1–7", "67:1–4", "1:1–7", "103:1–3"]);
  });

  it("keeps a missed verse inside the recited range and reports it", () => {
    const ps = buildPassages([e(70, 1, 0), e(70, 2, 5000), e(70, 4, 12000), e(70, 5, 17000)]);
    expect(ps).toHaveLength(1);
    expect(rangeLabel(ps[0]!)).toBe("70:1–5");
    expect(ps[0]!.unconfirmed).toEqual([3]);
  });

  it("starts a new passage when the reciter goes back or after a long gap", () => {
    const ps = buildPassages([e(36, 1, 0), e(36, 2, 5000), e(36, 1, 9000), e(36, 2, 14000), e(36, 3, 60000)]);
    expect(ps.map(rangeLabel)).toEqual(["36:1–2", "36:1–2", "36:3"]);
  });

  it("absorbs a late verse into its passage", () => {
    const ps = buildPassages([e(77, 1, 0), e(77, 3, 9000), e(77, 2, 9500, true)]);
    expect(ps.map(rangeLabel)).toEqual(["77:1–3"]);
    expect(ps[0]!.unconfirmed).toEqual([]);
  });
});
