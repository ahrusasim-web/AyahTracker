import { quranIndex } from "../core/quran/quranIndex";
import type { Passage } from "../core/session/passages";
import { playback } from "../app/audio";
import { ATTRIBUTION, usePassageText } from "../app/translationText";

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function rangeText(p: Passage): string {
  return p.from === p.to ? `Ayah ${p.from}` : `Ayahs ${p.from}–${p.to}`;
}

/** A recited passage: where it was, when, and Abdel Haleem's English for it as one paragraph. */
export function PassageCard({ p, live = false }: { p: Passage; live?: boolean }) {
  const surah = quranIndex.surah(p.s);
  const text = usePassageText(p.s, p.from, p.to, !live);
  const count = p.to - p.from + 1;

  const play = () =>
    playback.playSequence(Array.from({ length: count }, (_, i) => ({ entryId: -1, kind: "ayah" as const, v: { s: p.s, a: p.from + i } })));

  return (
    <article className={`passage${live ? " live" : ""}`}>
      <header>
        <h3>
          {surah?.nameEn} <span>{rangeText(p)}</span>
        </h3>
        <p className="meta">
          Surah {p.s} · {time(p.startedAt)}
          {live ? " · still reciting" : ""}
        </p>
      </header>
      {!live &&
        (text.status === "ready" ? (
          <p className="prose">
            {text.verses.map((v) => (
              <span key={v.a}>
                <sup>{v.a}</sup>
                {v.text}{" "}
              </span>
            ))}
          </p>
        ) : text.status === "loading" ? (
          <p className="prose muted">Loading the translation…</p>
        ) : (
          <p className="prose muted">{text.message}</p>
        ))}
      {!live && p.unconfirmed.length > 0 && (
        <p className="note">
          {p.unconfirmed.length === 1 ? `Ayah ${p.unconfirmed[0]} wasn't heard clearly` : `Ayahs ${p.unconfirmed.join(", ")} weren't heard clearly`}; included because the recitation
          carried on through {p.unconfirmed.length === 1 ? "it" : "them"}.
        </p>
      )}
      {!live && (
        <footer>
          <button className="textbtn" onClick={play}>
            Play translation audio
          </button>
          {text.status === "ready" && <small>{text.source === "import" ? "Your imported translation" : "Abdel Haleem"}</small>}
        </footer>
      )}
      {!live && text.status === "ready" && text.source === "qurancom" && <p className="attrib">{ATTRIBUTION}</p>}
    </article>
  );
}
