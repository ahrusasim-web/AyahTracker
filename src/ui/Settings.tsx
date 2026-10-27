import { useEffect, useRef, useState } from "react";
import { playback } from "../app/audio";
import { clearLibrary, importFiles, setHostedUrl } from "../app/library";
import { pushEngineSettings } from "../app/listener";
import { clearSessions, loadSessions, saveSettings, setState, useApp, type Settings as S } from "../app/store";
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

export function Settings({ onClose }: { onClose: () => void }) {
  const s = useApp((st) => st.settings);
  const lib = useApp((st) => st.library);
  const engine = useApp((st) => st.engine);
  const q = useApp((st) => st.quality);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(s.libraryUrl);
  const [sessions, setSessions] = useState(loadSessions);

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
          <Seg label="Playback mode" value={s.playbackMode} onChange={(playbackMode) => update({ playbackMode })} options={[["follow", "Follow live"], ["sequential", "Every verse in order"]]} />
          <p>
            {s.playbackMode === "follow"
              ? "Never more than one verse behind the imam: if verses come faster than their translations, older ones are skipped."
              : "Plays every confirmed verse once, in order. Up to 12 can wait; beyond that the oldest waiting ones are skipped."}
          </p>
          <Toggle checked={s.autoTranslate} onChange={(autoTranslate) => update({ autoTranslate })} title="Play translations automatically" detail="Off: verses are still recognised and listed; tap one to hear it." />
        </section>

        <section>
          <h3>Your translation files</h3>
          <p>
            {lib.ayahFiles || lib.surahFiles
              ? `${lib.ayahFiles.toLocaleString()} verse ${lib.ayahFiles === 1 ? "file" : "files"} and ${lib.surahFiles} whole-surah ${lib.surahFiles === 1 ? "file" : "files"} on this device${lib.ayahFiles < quranIndex.verseCount ? ` (${(quranIndex.verseCount - lib.ayahFiles).toLocaleString()} verses have no file)` : ""}.`
              : "No files yet. Choose the folder that holds files named like 29-11.mp3 or 92-02.mp3, whole-surah files like 104.mp3, and optionally start.mp3 and stop.mp3."}
            {lib.duplicates.length ? ` ${lib.duplicates.length} duplicate names were ignored (for example ${lib.duplicates[0]}).` : ""}
          </p>
          {lib.importing && (
            <div className="field">
              <div className="loadbar"><i style={{ width: `${(lib.importing.done / lib.importing.total) * 100}%` }} /></div>
              <p className="loadtext">Saving {lib.importing.done.toLocaleString()} of {lib.importing.total.toLocaleString()} files to this device…</p>
            </div>
          )}
          <div className="btnrow">
            <button className="btn primary" onClick={() => folderRef.current?.click()} disabled={!!lib.importing}>Choose folder</button>
            <button className="btn" onClick={() => filesRef.current?.click()} disabled={!!lib.importing}>Choose files</button>
            {lib.ayahFiles + lib.surahFiles > 0 && <button className="btn danger" onClick={() => void clearLibrary()}>Remove from this device</button>}
          </div>
          <input ref={folderRef} type="file" hidden multiple accept="audio/mpeg,.mp3" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => e.target.files && void importFiles(e.target.files)} />
          <input ref={filesRef} type="file" hidden multiple accept="audio/mpeg,.mp3" onChange={(e) => e.target.files && void importFiles(e.target.files)} />
          <p>Files stay on this phone; nothing is uploaded. If your browser can't pick a folder, open the folder in "Choose files" and select all.</p>
          <div className="field">
            <label htmlFor="liburl"><b>Or a hosted folder</b></label>
            <input id="liburl" type="url" placeholder="translations/  or  https://example.com/translations/" value={url} onChange={(e) => setUrl(e.target.value)}
              onBlur={() => { if (url !== s.libraryUrl) { update({ libraryUrl: url }); void setHostedUrl(url); } }} />
          </div>
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
          <h3>Past sessions</h3>
          {sessions.length === 0 ? (
            <p>Sessions are kept on this device after you stop listening.</p>
          ) : (
            <>
              <ul className="sessions">
                {sessions.map((x) => (
                  <li key={x.startedAt}>
                    <span>{new Date(x.startedAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {PRIORS[x.prayer]?.label}</span>
                    <span>
                      {x.entries.length} verses
                      {x.entries.length ? ` · ${x.entries[0]!.v.s}:${x.entries[0]!.v.a} … ${x.entries[x.entries.length - 1]!.v.s}:${x.entries[x.entries.length - 1]!.v.a}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="btnrow"><button className="btn danger" onClick={() => { clearSessions(); setSessions([]); }}>Clear past sessions</button></div>
            </>
          )}
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
          <p>Recognition runs entirely on this phone; no audio leaves it. Model: Tilawa streaming Zipformer (Quran-Lab weights, NPL-1.2 — free, non-commercial use). Quran text: Tanzil Uthmani (CC-BY 3.0).</p>
        </section>
      </div>
    </>
  );
}
