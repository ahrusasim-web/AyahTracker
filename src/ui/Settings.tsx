import { useEffect, useRef, useState } from "react";
import { playback } from "../app/audio";
import { clearLibrary, importFiles, setHostedUrl } from "../app/library";
import { pushEngineSettings } from "../app/listener";
import { notify, saveSettings, setState, useApp, type Settings as S } from "../app/store";
import { downloadAllText, importTranslationFile } from "../app/translationText";
import { quranIndex } from "../core/quran/quranIndex";
import { PRIORS } from "../core/tracker/priors";
import type { PrayerContext, Sensitivity } from "../core/types";
import { CloseIcon } from "./icons";

export function update(patch: Partial<S>): void {
  setState((st) => {
    const settings = { ...st.settings, ...patch };
    saveSettings(settings);
    return { settings };
  });
  if ("playbackMode" in patch) playback.mode = patch.playbackMode!;
  if ("catchUp" in patch) playback.catchUp = patch.catchUp!;
  if ("autoTranslate" in patch) {
    playback.autoPlay = patch.autoTranslate!;
    if (!patch.autoTranslate) playback.stopAll();
  }
  if ("prayer" in patch || "sensitivity" in patch || "conditioning" in patch) pushEngineSettings();
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, title, detail }: { checked: boolean; onChange: (v: boolean) => void; title: string; detail: string }) {
  return (
    <label className="switchline">
      <div>
        <b>{title}</b>
        <small>{detail}</small>
      </div>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      </span>
    </label>
  );
}

const PRAYER_NOTE: Record<PrayerContext, string> = {
  general: "No assumptions about what will be recited.",
  jummah: "Expects Al-Fatihah each rak'ah and leans slightly toward Al-Jumu'ah, Al-Munafiqun, Al-A'la and Al-Ghashiyah.",
  maghrib: "Expects Al-Fatihah each rak'ah and leans slightly toward the short surahs (Ad-Duha to An-Nas), At-Tur and Al-Mursalat.",
  isha: "Expects Al-Fatihah each rak'ah and leans slightly toward the middle surahs (An-Naba' to Al-Layl) and At-Tin.",
};
const SENS_NOTE: Record<Sensitivity, string> = {
  careful: "Fewest mistakes. Short or look-alike verses wait for the next verse before showing.",
  balanced: "Recommended. Quick on the running passage, cautious about new locations.",
  fast: "Shows new locations sooner, with a higher chance of a wrong verse in noisy rooms.",
};

export function Settings({ onClose, onOpenLibrary, onOpenSessions }: { onClose: () => void; onOpenLibrary: () => void; onOpenSessions: () => void }) {
  const s = useApp((st) => st.settings);
  const lib = useApp((st) => st.library);
  const engine = useApp((st) => st.engine);
  const q = useApp((st) => st.quality);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(s.libraryUrl);
  const textRef = useRef<HTMLInputElement>(null);
  const [textProgress, setTextProgress] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const level = q ? Math.max(0, Math.min(1, (q.levelDb + 70) / 60)) : 0;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </header>

        <section>
          <h3>Prayer</h3>
          <Seg<PrayerContext>
            label="Prayer"
            value={s.prayer}
            onChange={(prayer) => update({ prayer })}
            options={(Object.keys(PRIORS) as PrayerContext[]).map((k) => [k, PRIORS[k].label])}
          />
          <p>{PRAYER_NOTE[s.prayer]} Any verse of the Quran can still be recognised.</p>
        </section>

        <section>
          <h3>Translation playback</h3>
          <Seg label="Playback mode" value={s.playbackMode} onChange={(playbackMode) => update({ playbackMode })} options={[["sequential", "Every ayah, in order"], ["follow", "Stay close to live"]]} />
          <p>
            {s.playbackMode === "sequential"
              ? "Each translation plays to the end, then the next. Recognition keeps going in the background, so ayahs recited meanwhile wait their turn and none are skipped."
              : "Never more than one ayah behind the imam: if ayahs come faster than their translations, the waiting ones are skipped."}
          </p>
          {s.playbackMode === "sequential" && (
            <Toggle checked={s.catchUp} onChange={(catchUp) => update({ catchUp })} title="Catch up when behind" detail="Plays slightly faster (up to 1.25×) while several translations are waiting, back to normal once caught up." />
          )}
          <Toggle checked={s.autoTranslate} onChange={(autoTranslate) => update({ autoTranslate })} title="Play translations automatically" detail="Off: verses are still recognised and listed; tap one to hear it." />
        </section>

        <section>
          <h3>Your translation audio</h3>
          <p>
            {lib.ayahFiles || lib.surahFiles
              ? `${lib.ayahFiles.toLocaleString()} of ${quranIndex.verseCount.toLocaleString()} verses · ${lib.surahFiles} whole-surah ${lib.surahFiles === 1 ? "file" : "files"}`
              : "No files yet. Add the folder with files named like 29-11.mp3 or 92-02.mp3 (and 104.mp3 for whole surahs)."}
          </p>
          {lib.importing && (
            <div className="field">
              <div className="loadbar"><i style={{ width: `${(lib.importing.done / lib.importing.total) * 100}%` }} /></div>
              <p className="loadtext">Saving {lib.importing.done.toLocaleString()} of {lib.importing.total.toLocaleString()} files to this phone…</p>
            </div>
          )}
          <div className="btnrow">
            {lib.ayahFiles + lib.surahFiles > 0 && <button className="btn primary" onClick={onOpenLibrary}>Browse and play</button>}
            <button className={`btn${lib.ayahFiles + lib.surahFiles > 0 ? "" : " primary"}`} onClick={() => folderRef.current?.click()} disabled={!!lib.importing}>Add folder</button>
            <button className="btn" onClick={() => filesRef.current?.click()} disabled={!!lib.importing}>Add files</button>
          </div>
          <input ref={folderRef} type="file" hidden multiple accept="audio/mpeg,.mp3" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => e.target.files && void importFiles(e.target.files)} />
          <input ref={filesRef} type="file" hidden multiple accept="audio/mpeg,.mp3" onChange={(e) => e.target.files && void importFiles(e.target.files)} />
          <details>
            <summary>More options</summary>
            <p>Files stay on this phone; nothing is uploaded. If your browser can't pick a folder, use Add files and select them all.{lib.duplicates.length ? ` ${lib.duplicates.length} duplicate names were ignored (for example ${lib.duplicates[0]}).` : ""}</p>
            <div className="field">
              <label htmlFor="liburl"><b>Hosted folder</b> (optional)</label>
              <input id="liburl" type="url" placeholder="translations/" value={url} onChange={(e) => setUrl(e.target.value)}
                onBlur={() => { if (url !== s.libraryUrl) { update({ libraryUrl: url }); void setHostedUrl(url); } }} />
            </div>
            {lib.ayahFiles + lib.surahFiles > 0 && <button className="btn danger" onClick={() => { if (confirm("Remove all translation files from this phone?")) void clearLibrary(); }}>Remove files from this phone</button>}
          </details>
        </section>

        <section>
          <h3>Passage summaries</h3>
          <p>When a passage ends, it's summarised in English using Abdel Haleem's translation, loaded from Quran.com and kept on this phone.</p>
          <div className="btnrow">
            <button className="btn" disabled={textProgress !== null} onClick={() => {
              setTextProgress(0);
              void downloadAllText((n) => setTextProgress(n)).then((ok) => { setTextProgress(null); notify(ok === 114 ? "The full translation text is saved for offline use." : `Saved ${ok} of 114 surahs; the rest will load when needed.`, ok === 114 ? "info" : "warn"); });
            }}>{textProgress === null ? "Save all for offline" : `Saving… ${textProgress}/114`}</button>
            <button className="btn" onClick={() => textRef.current?.click()}>Use my own file</button>
          </div>
          <input ref={textRef} type="file" hidden accept=".json,.txt,application/json,text/plain" onChange={(e) => e.target.files?.[0] && void importTranslationFile(e.target.files[0])} />
        </section>

        <section>
          <h3>Recognition</h3>
          <Seg<Sensitivity> label="Sensitivity" value={s.sensitivity} onChange={(sensitivity) => update({ sensitivity })} options={[["careful", "Careful"], ["balanced", "Balanced"], ["fast", "Fast"]]} />
          <p>{SENS_NOTE[s.sensitivity]}</p>
          <Toggle checked={s.conditioning} onChange={(conditioning) => update({ conditioning })} title="Audio clean-up" detail="Gentle rumble filter and automatic level for distant recitation. No noise suppression." />
          <Toggle checked={s.speakerMode} onChange={(speakerMode) => update({ speakerMode })} title="Translations play through the phone speaker" detail="Asks the browser to cancel them from the microphone. Takes effect next time you start listening. Earbuds work better." />
        </section>

        <section>
          <h3>Phone</h3>
          <Toggle checked={s.keepScreenOn} onChange={(keepScreenOn) => update({ keepScreenOn })} title="Keep the screen on while listening" detail="The most reliable way to keep listening. Dim the screen and place the phone face down." />
          <Toggle checked={s.mediaKeys} onChange={(mediaKeys) => update({ mediaKeys })} title="Earbud play/pause starts and stops listening" detail="Works in Chrome on Android while the app's media notification is showing. Not every earbud or browser sends the key." />
          <p>
            With the screen locked, Android may pause the microphone for web pages. If listening stops, the app says so and a tap on Start listening resumes. For guaranteed screen-off listening, see "Screen-off listening" in the README (Android shell with a foreground service).
          </p>
        </section>

        <section>
          <h3>Sessions</h3>
          <p>Every listening session is kept on this phone, with its passages and their English summaries.</p>
          <div className="btnrow"><button className="btn" onClick={onOpenSessions}>Open sessions</button></div>
        </section>

        <section>
          <h3>About this device</h3>
          <dl className="kv">
            <dt>Recogniser</dt>
            <dd>{engine.status === "ready" ? `Ready · ${engine.threads ?? 1} thread${(engine.threads ?? 1) > 1 ? "s" : ""}` : engine.status === "error" ? engine.error : engine.detail}</dd>
            <dt>Speed</dt>
            <dd>{engine.rtf ? `${(engine.rtf * 100).toFixed(0)}% of real time${engine.rtf > 0.8 ? " — too slow for live use" : ""}` : "Measured while listening"}</dd>
            <dt>Input level</dt>
            <dd><div className="meter" aria-label="Input level"><i style={{ width: `${level * 100}%` }} /></div></dd>
            <dt>Speech vs noise</dt>
            <dd>{q ? `${q.snrDb.toFixed(0)} dB · gain ${q.gainDb >= 0 ? "+" : ""}${q.gainDb.toFixed(0)} dB` : "—"}</dd>
          </dl>
          <p>Recognition runs entirely on this phone; no audio leaves it. Model: Tilawa streaming Zipformer (Quran-Lab weights, NPL-1.2 — free, non-commercial use). English summaries: M.A.S. Abdel Haleem's translation (Oxford University Press) via Quran.com.</p>
        </section>
      </div>
    </>
  );
}
