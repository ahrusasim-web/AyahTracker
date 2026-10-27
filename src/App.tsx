import { useEffect, useState } from "react";
import { initLibrary } from "./app/library";
import { initEngine, toggleListening } from "./app/listener";
import { setState, useApp } from "./app/store";
import { PRIORS } from "./core/tracker/priors";
import { History } from "./ui/History";
import { GearIcon, CloseIcon, MicIcon, StopIcon } from "./ui/icons";
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

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const lib = useApp((s) => s.library);
  useEffect(() => {
    initEngine();
    void initLibrary();
  }, []);
  return (
    <div className="app">
      <Notice />
      <div className="topbar">
        <StatusLine />
        <button className="iconbtn" aria-label="Settings" onClick={() => setSettingsOpen(true)}><GearIcon /></button>
      </div>
      <Now />
      <Playing />
      {lib.source === "none" && !lib.importing && (
        <div className="playing note" role="note">
          <span className="what">
            Add your English translation files to hear them
            <small>Settings → Your translation files. Recognition works without them.</small>
          </span>
          <button className="textbtn" onClick={() => setSettingsOpen(true)}>Add files</button>
        </div>
      )}
      <History />
      <Dock />
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
