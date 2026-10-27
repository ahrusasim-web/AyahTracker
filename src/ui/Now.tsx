import { quranIndex } from "../core/quran/quranIndex";
import { useApp } from "../app/store";
import { Rosette } from "./Rosette";

/** The current verse: confirmed (verdigris), being heard (brass trace), or nothing yet. */
export function Now() {
  const tentative = useApp((s) => s.tentative);
  const history = useApp((s) => s.history);
  const listen = useApp((s) => s.listen);
  const tracker = useApp((s) => s.tracker);
  const engineStatus = useApp((s) => s.engine.status);
  const last = history.length ? history[history.length - 1]! : null;

  // A verse being heard that is not the last confirmed one takes the stage, in brass.
  const showTentative = !!tentative && !(last && last.v.s === tentative.v.s && last.v.a === tentative.v.a);
  const v = showTentative ? tentative!.v : (last?.v ?? null);
  const surah = v ? quranIndex.surah(v.s) : null;
  const state: "idle" | "tentative" | "confirmed" = v ? (showTentative ? "tentative" : "confirmed") : "idle";
  const label = v && surah ? `${showTentative ? "Identifying" : "Confirmed"}: Surah ${v.s}, ${surah.nameEn}, Ayah ${v.a}` : "No verse yet";
  const idleText =
    listen !== "listening"
      ? engineStatus === "ready" ? "Ready" : engineStatus === "error" ? "Unavailable" : "Loading…"
      : tracker === "identifying" ? "Identifying…" : tracker === "paused" ? "Paused" : "Listening…";

  return (
    <section className="now" aria-live="polite" aria-atomic="true">
      <h1 className="surah-title">{surah ? surah.nameEn : " "}</h1>
      <p className="surah-en">{surah ? `Surah ${surah.n} · ${surah.ayahs} ayahs` : " "}</p>
      <Rosette state={state} progress={showTentative ? tentative!.progress : 1} label={label}>
        {v ? v.a : idleText}
      </Rosette>
      <p className="ayah-of">{v && surah ? `Ayah ${v.a}` : ""}</p>
      {showTentative && tentative!.reason === "pending" && <p className="hint">Checking — waiting for more of the recitation before confirming</p>}
      {showTentative && tentative!.reason === "tracking" && <p className="hint">Hearing this verse ({tentative!.matchedWords} of {tentative!.totalWords} words)</p>}
      {!showTentative && last?.ambiguousWith?.length ? (
        <p className="hint ambig">These exact words occur in {last.ambiguousWith.length + 1} places; the next verse will settle which.</p>
      ) : null}
    </section>
  );
}
