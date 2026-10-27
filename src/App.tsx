import { useEffect, useMemo, useState } from "react";
import { initLibrary } from "./app/library";
import { initEngine, toggleListening } from "./app/listener";
import { setState, useApp } from "./app/store";
import { PRIORS } from "./core/tracker/priors";
import { buildPassages } from "./core/session/passages";
import { LibraryScreen, LibrarySurahScreen } from "./ui/Library";
import { PassageCard } from "./ui/PassageCard";
import { SessionScreen, SessionsScreen } from "./ui/Sessions";
import { History } from "./ui/History";
import { GearIcon, CloseIcon, MicIcon, SessionsIcon, StopIcon } from "./ui/icons";
import { Now } from "./ui/Now";
import { Playing } from "./ui/Playing";
import { Settings, update } from "./ui/Settings";

function StatusLine() {
  const listen = useApp((s) => s.listen);
  const tracker = useApp((s) => s.tracker);
  const engine = useApp((s) => s.engine);
  const prayer = useApp((s) => s.settings.prayer);
  let dot = "", text = "Not listening";
  if (engine.status === "error") { dot = "err"; text = "Recogniser failed to load"; }
  else if (listen === "starting") { dot = "on"; text = "Starting the microphone"; }
  else if (listen === "listening") {
    dot = tracker === "tracking" ? "tracking" : "on";
    text = { listening: "Listening", identifying: "Identifying", tracking: "Following the recitation", paused: "Listening · recitation paused" }[tracker];
  }
  return (
    <div className="status" role="status">
      <span className={`dot ${dot}`} aria-hidden="true" />
      <span><b>{text}</b>{prayer !== "general" ? ` · ${PRIORS[prayer].label}` : ""}</span>
    </div>
  );
}

function Dock() {
  const listen = useApp((s) => s.listen);
  const engine = useApp((s) => s.engine);
  const auto = useApp((s) => s.settings.autoTranslate);
  const lib = useApp((s) => s.library);
  const on = listen === "listening" || listen === "stopping";
  const busy = listen === "starting" || listen === "stopping";
  return (
    <div className="dock">
      {engine.status === "loading" && (
        <div>
          <div className="loadbar"><i style={{ width: `${Math.round(engine.progress * 100)}%` }} /></div>
          <p className="loadtext">{engine.detail}</p>
        </div>
      )}
      {engine.status === "error" && <p className="loadtext">{engine.error}</p>}
      <button className={`listen${on ? " stop" : ""}`} onClick={() => void toggleListening()} disabled={busy || (engine.status !== "ready" && !on)}>
        {on ? <StopIcon /> : <MicIcon />}
        {on ? "Stop listening" : listen === "starting" ? "Starting…" : "Start listening"}
      </button>
      <div className="dock-row">
        <label className="switch">
          <input type="checkbox" checked={auto} onChange={(e) => update({ autoTranslate: e.target.checked })} />
          English translation
        </label>
        <span>{lib.source === "none" ? "No translation files yet" : `${lib.ayahFiles.toLocaleString()} verse files`}</span>
      </div>
    </div>
  );
}

function Notice() {
  const n = useApp((s) => s.notice);
  if (!n) return null;
  return (
    <div className={`notice ${n.tone}`} role={n.tone === "error" ? "alert" : "status"}>
      <p>{n.text}</p>
      <button className="iconbtn" style={{ width: 32, height: 32 }} aria-label="Dismiss" onClick={() => setState({ notice: null })}><CloseIcon /></button>
    </div>
  );
}

/** The latest passage once it has finished: a pause, a new surah, or listening stopped. */
function JustRecited() {
  const history = useApp((s) => s.history);
  const listen = useApp((s) => s.listen);
  const tracker = useApp((s) => s.tracker);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  const passages = useMemo(() => buildPassages(history), [history]);
  if (!passages.length) return null;
  const last = passages[passages.length - 1]!;
  const lastDone = listen !== "listening" || (tracker !== "tracking" && now - last.endedAt > 8000);
  const done = lastDone ? last : passages.length > 1 ? passages[passages.length - 2]! : null;
  if (!done) return null;
  return (
    <section className="justrecited" aria-label="Just recited">
      <h2>Just recited</h2>
      <PassageCard p={done} />
    </section>
  );
}

type View = { name: "main" } | { name: "sessions" } | { name: "session"; startedAt: number } | { name: "library" } | { name: "librarySurah"; s: number };

export function App() {
  const [view, setView] = useState<View>({ name: "main" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const lib = useApp((s) => s.library);
  useEffect(() => {
    initEngine();
    void initLibrary();
  }, []);

  const overlay =
    view.name === "sessions" ? <SessionsScreen onBack={() => setView({ name: "main" })} onOpen={(startedAt) => setView({ name: "session", startedAt })} />
    : view.name === "session" ? <SessionScreen startedAt={view.startedAt} onBack={() => setView({ name: "sessions" })} />
    : view.name === "library" ? <LibraryScreen onBack={() => setView({ name: "main" })} onOpen={(s) => setView({ name: "librarySurah", s })} />
    : view.name === "librarySurah" ? <LibrarySurahScreen s={view.s} onBack={() => setView({ name: "library" })} />
    : null;

  return (
    <div className="app">
      <Notice />
      {overlay ? (
        <>
          {overlay}
          <div className="dock slim"><Playing /></div>
        </>
      ) : (
        <>
          <div className="topbar">
            <StatusLine />
            <button className="iconbtn" aria-label="Sessions" onClick={() => setView({ name: "sessions" })}><SessionsIcon /></button>
            <button className="iconbtn" aria-label="Settings" onClick={() => setSettingsOpen(true)}><GearIcon /></button>
          </div>
          <Now />
          <Playing />
          {lib.source === "none" && !lib.importing && (
            <div className="playing note" role="note">
              <span className="what">
                Add your English translation files to hear them
                <small>Recognition and summaries work without them.</small>
              </span>
              <button className="textbtn" onClick={() => setSettingsOpen(true)}>Add files</button>
            </div>
          )}
          <JustRecited />
          <History />
          <Dock />
        </>
      )}
      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          onOpenLibrary={() => { setSettingsOpen(false); setView({ name: "library" }); }}
          onOpenSessions={() => { setSettingsOpen(false); setView({ name: "sessions" }); }}
        />
      )}
    </div>
  );
}
