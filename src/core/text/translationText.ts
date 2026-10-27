/**
 * Helpers for English translation *text* (shown in passage summaries). The text itself is
 * never bundled with the app: it comes from Quran.com's API (Abdel Haleem's translation is
 * published by Oxford University Press and licensed to Quran.com) or from a file the user
 * imports, and is cached on the device.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Quran.com returns lightly marked-up text with footnote markers; reduce it to plain prose. */
export function cleanApiText(html: string): string {
  return html
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse an imported translation file into "surah:ayah" → text. Accepted:
 *  - JSON object keyed "2:255"
 *  - JSON array of { surah|chapter|sura, ayah|verse|aya, text|translation }
 *  - Tanzil-style lines "2|255|text" (also tab- or comma-separated with the same order)
 */
export function parseTranslationFile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const trimmed = content.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const data: unknown = JSON.parse(trimmed);
    if (Array.isArray(data)) {
      for (const row of data) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const s = Number(r.surah ?? r.chapter ?? r.sura);
        const a = Number(r.ayah ?? r.verse ?? r.aya);
        const t = r.text ?? r.translation;
        if (Number.isInteger(s) && Number.isInteger(a) && typeof t === "string") out.set(`${s}:${a}`, cleanApiText(t));
      }
    } else if (data && typeof data === "object") {
      for (const [k, t] of Object.entries(data as Record<string, unknown>)) {
        const m = /^(\d{1,3})[:_.-](\d{1,3})$/.exec(k);
        if (m && typeof t === "string") out.set(`${Number(m[1])}:${Number(m[2])}`, cleanApiText(t));
      }
    }
    return out;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const m = /^\s*(\d{1,3})\s*[|\t,]\s*(\d{1,3})\s*[|\t,]\s*(.+)$/.exec(line);
    if (m) out.set(`${Number(m[1])}:${Number(m[2])}`, cleanApiText(m[3]!));
  }
  return out;
}

/** Pick Abdel Haleem's edition from Quran.com's translation list. */
export function findHaleem(list: unknown): { id: number; name: string } | null {
  const rows = (list as { translations?: unknown[] } | null)?.translations;
  if (!Array.isArray(rows)) return null;
  for (const r of rows) {
    const t = r as { id?: number; name?: string; author_name?: string; translated_name?: { name?: string } };
    const hay = `${t.name ?? ""} ${t.author_name ?? ""} ${t.translated_name?.name ?? ""}`;
    if (typeof t.id === "number" && /haleem/i.test(hay)) return { id: t.id, name: t.author_name || t.name || "Abdel Haleem" };
  }
  return null;
}
