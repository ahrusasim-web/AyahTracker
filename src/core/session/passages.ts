import type { VerseRef } from "../types";

export interface PassageEntry {
  id: number;
  v: VerseRef;
  /** Wall-clock ms. */
  wall: number;
  late?: boolean;
  via?: string;
}

export interface Passage {
  s: number;
  from: number;
  to: number;
  entryIds: number[];
  /** Ayahs inside from..to that were recited (the range is contiguous) but not individually confirmed. */
  unconfirmed: number[];
  startedAt: number;
  endedAt: number;
}

/** A new passage starts when the surah changes, the reciter goes back, skips ahead, or a long gap passes. */
const MAX_FORWARD_STEP = 3;
const MAX_GAP_MS = 30_000;

/**
 * Group a session's confirmed verses into recited passages: "Al-Mulk 67:1–4", then
 * "Al-Fatihah 1:1–7", and so on. Within a passage the reciter moves forward through one surah;
 * a verse the recogniser missed inside the range is still part of what was recited, and is
 * listed in `unconfirmed` so the summary can say so.
 */
export function buildPassages(entries: PassageEntry[]): Passage[] {
  const out: Passage[] = [];
  let cur: Passage | null = null;
  for (const e of entries) {
    const brk =
      !cur ||
      e.v.s !== cur.s ||
      e.v.a < cur.to - (e.late ? 1 : 0) ||
      e.v.a > cur.to + MAX_FORWARD_STEP ||
      e.wall - cur.endedAt > MAX_GAP_MS;
    if (brk) {
      cur = { s: e.v.s, from: e.v.a, to: e.v.a, entryIds: [e.id], unconfirmed: [], startedAt: e.wall, endedAt: e.wall };
      out.push(cur);
      continue;
    }
    cur!.entryIds.push(e.id);
    cur!.from = Math.min(cur!.from, e.v.a);
    cur!.to = Math.max(cur!.to, e.v.a);
    cur!.endedAt = Math.max(cur!.endedAt, e.wall);
  }
  for (const p of out) {
    const have = new Set(entries.filter((e) => p.entryIds.includes(e.id) && e.via !== "inferred").map((e) => e.v.a));
    for (let a = p.from; a <= p.to; a++) if (!have.has(a)) p.unconfirmed.push(a);
  }
  return out;
}

export function rangeLabel(p: Pick<Passage, "s" | "from" | "to">): string {
  return p.from === p.to ? `${p.s}:${p.from}` : `${p.s}:${p.from}–${p.to}`;
}
