import { useMemo, useState } from "react";
import { quranIndex } from "../core/quran/quranIndex";
import { playback } from "../app/audio";
import { deviceAyahs, hasHosted } from "../app/library";
import { useApp } from "../app/store";
import { Screen } from "./Screen";
import { ChevronIcon, PlayIcon } from "./icons";

/** Which surahs and ayahs have translation files, with a way into each surah to listen. */
export function LibraryScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (s: number) => void }) {
  const cov = useApp((s) => s.library.coverage);
  const total = useApp((s) => s.library.ayahFiles);
  const surahFiles = useApp((s) => s.library.surahFiles);
  const [filter, setFilter] = useState<"all" | "incomplete">("all");
  const rows = quranIndex.surahs.filter((s) => filter === "all" || cov.verses[s.n - 1]! < s.ayahs || !cov.surahFile[s.n - 1]);
  const complete = quranIndex.surahs.filter((s) => cov.verses[s.n - 1] === s.ayahs).length;

  return (
    <Screen title="Translation files" onBack={onBack}>
      <div className="libsummary">
        <div className="bigstat"><b>{total.toLocaleString()}</b><span>of {quranIndex.verseCount.toLocaleString()} verses</span></div>
        <div className="bigstat"><b>{complete}</b><span>of 114 surahs complete</span></div>
        <div className="bigstat"><b>{surahFiles}</b><span>whole-surah files</span></div>
      </div>
      {hasHosted() && <p className="screen-sub">Files in your hosted folder aren't listed here; they're looked up when played.</p>}
      <div className="seg slim" role="group" aria-label="Show">
        <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All surahs</button>
        <button aria-pressed={filter === "incomplete"} onClick={() => setFilter("incomplete")}>Missing files</button>
      </div>
      {rows.length === 0 ? (
        <p className="empty">Every surah has all its verse files and a whole-surah file.</p>
      ) : (
        <ul className="surahlist">
          {rows.map((s) => {
            const n = cov.verses[s.n - 1]!;
            const full = n === s.ayahs;
            return (
              <li key={s.n}>
                <button onClick={() => onOpen(s.n)}>
                  <span className="num">{s.n}</span>
                  <span className="name">{s.nameEn}</span>
                  <span className={`count${full ? " full" : n === 0 ? " none" : ""}`}>
                    {full ? "All" : n}
                    <small>/{s.ayahs}</small>
                  </span>
                  <span className={`dotfile${cov.surahFile[s.n - 1] ? " on" : ""}`} title={cov.surahFile[s.n - 1] ? "Whole-surah file" : "No whole-surah file"} />
                  <ChevronIcon />
                </button>
                <span className="bar" aria-hidden="true"><i style={{ width: `${(n / s.ayahs) * 100}%` }} /></span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="legend"><span className="dotfile on" /> whole-surah file ({"{surah}"}.mp3) present</p>
    </Screen>
  );
}

/** One surah: every ayah as a tile. Tap a tile to play from there, in order. */
export function LibrarySurahScreen({ s, onBack }: { s: number; onBack: () => void }) {
  useApp((st) => st.library.coverage); // re-render when files change
  const surah = quranIndex.surah(s)!;
  const have = useMemo(() => new Set(deviceAyahs(s)), [s]);
  const hosted = hasHosted();
  const current = useApp((st) => st.playback.current);
  const hasSurahFile = useApp((st) => st.library.coverage.surahFile[s - 1]);

  const playFrom = (a: number) => {
    const items = [];
    for (let x = a; x <= surah.ayahs; x++) if (have.has(x) || hosted) items.push({ entryId: -1, kind: "ayah" as const, v: { s, a: x } });
    playback.playSequence(items);
  };

  return (
    <Screen title={surah.nameEn} onBack={onBack}>
      <p className="screen-sub">
        Surah {s} · {have.size === surah.ayahs ? `all ${surah.ayahs} verse files` : `${have.size} of ${surah.ayahs} verse files`}
      </p>
      <div className="btnrow">
        <button className="btn primary" disabled={!have.size && !hosted} onClick={() => playFrom(1)}><PlayIcon /> Play verses in order</button>
        <button className="btn" disabled={!hasSurahFile && !hosted} onClick={() => playback.playManual(-1, { s, a: 0 }, "surah")}>Play {s}.mp3</button>
      </div>
      <p className="hintline">Tap a verse to play from there. Dim verses have no file.</p>
      <div className="ayahgrid">
        {Array.from({ length: surah.ayahs }, (_, i) => i + 1).map((a) => {
          const on = have.has(a);
          const playing = current?.kind === "ayah" && current.v.s === s && current.v.a === a;
          return (
            <button key={a} className={`tile${on ? "" : " off"}${playing ? " is-playing" : ""}`} disabled={!on && !hosted} onClick={() => playFrom(a)} aria-label={`Ayah ${a}${on ? "" : ", no file"}`}>
              {a}
            </button>
          );
        })}
      </div>
    </Screen>
  );
}
