import { quranIndex } from "../core/quran/quranIndex";
import { playback } from "../app/audio";
import { useApp } from "../app/store";

export function Playing() {
  const pb = useApp((s) => s.playback);
  if (pb.current) {
    const c = pb.current;
    const name = quranIndex.surah(c.v.s)?.nameEn;
    return (
      <div className="playing" role="status">
        <span className="bars" aria-hidden="true"><i /><i /><i /></span>
        <span className="what">
          {c.kind === "surah" ? `Full translation of ${name}` : `Translation of ${c.v.s}:${c.v.a}`}
          <small>{c.manual ? "Replay" : pb.queued.length ? `${pb.queued.length} waiting` : name}</small>
        </span>
        <button className="textbtn" onClick={() => playback.togglePause()}>{pb.paused ? "Resume" : "Pause"}</button>
        <button className="textbtn" onClick={() => (c.manual ? playback.stopAll() : playback.skip())}>{c.manual ? "Stop" : "Skip"}</button>
      </div>
    );
  }
  if (pb.missing) {
    return (
      <div className="playing missing" role="status">
        <span className="what">
          No translation file for {pb.missing.s}:{pb.missing.a}
          <small>Add {pb.missing.s}-{pb.missing.a}.mp3 to your library. Listening continues.</small>
        </span>
      </div>
    );
  }
  return null;
}
