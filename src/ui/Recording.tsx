import { useEffect } from "react";
import { deleteRecording, getRecordingFile, useRecording } from "../app/recorder";
import { loadRecording, pauseRecording, playRecording, seekRecording, unloadRecording } from "../app/recordingPlayer";
import { notify, useApp, type SavedSession } from "../app/store";
import { formatDuration, formatSize, recordingFileName } from "../core/session/recording";
import { PRIORS } from "../core/tracker/priors";
import { PauseIcon, PlayIcon, RecDot } from "./icons";

/** A session's recording: play, scrub, skip, save to the phone, delete. */
export function RecordingCard({ session }: { session: SavedSession }) {
  const id = session.startedAt;
  const meta = useRecording(id);
  const rp = useApp((s) => s.recPlay);
  const recordingNow = useApp((s) => s.recording?.id === id);
  const listening = useApp((s) => s.listen !== "idle");

  // Leaving the session closes its recording.
  useEffect(() => () => unloadRecording(), [id]);

  if (recordingNow) {
    return (
      <section className="reccard live" aria-label="Recording">
        <p className="recnote"><RecDot /> Recording now. It will be here to play back when you stop listening.</p>
      </section>
    );
  }
  if (meta === undefined) return null;
  if (!meta) {
    return session.recorded ? <p className="recgone">The recording of this session is no longer on this phone.</p> : null;
  }
  if (meta.status !== "done") {
    return (
      <section className="reccard" aria-label="Recording">
        <p className="recnote">Saving the recording…</p>
      </section>
    );
  }

  const mine = rp.id === id;
  const dur = mine && rp.duration ? rp.duration : meta.durationMs / 1000;
  const t = mine ? Math.min(rp.t, dur) : 0;
  const playing = mine && rp.playing;

  const toggle = async () => {
    if (playing) return pauseRecording();
    if (!(await loadRecording(id))) return notify("The recording of this session isn't on this phone any more.", "warn");
    await playRecording();
  };
  const seekTo = async (sec: number) => {
    if (await loadRecording(id)) seekRecording(sec);
  };
  const save = async () => {
    const blob = await getRecordingFile(id);
    if (!blob) return;
    const name = recordingFileName(id, session.prayer !== "general" ? PRIORS[session.prayer]?.label ?? null : null, meta.mime);
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    notify(`Saved as "${name}" in your downloads.`);
  };
  const remove = async () => {
    if (!confirm("Delete this recording from this phone? The session's verses stay.")) return;
    unloadRecording();
    await deleteRecording(id);
  };

  return (
    <section className="reccard" aria-label="Recording of this session">
      <div className="recrow">
        <button className="playbtn" onClick={() => void toggle()} disabled={listening || (mine && rp.loading)} aria-label={playing ? "Pause recording" : "Play recording"}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="rectrack">
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.floor(dur))}
            step={1}
            value={Math.floor(t)}
            onChange={(e) => void seekTo(Number(e.target.value))}
            aria-label="Position in the recording"
            aria-valuetext={`${formatDuration(t * 1000)} of ${formatDuration(dur * 1000)}`}
            style={{ ["--pos" as string]: `${dur ? (t / dur) * 100 : 0}%` }}
          />
          <div className="rectimes">
            <span>{formatDuration(t * 1000)}</span>
            <span>{formatDuration(dur * 1000)}</span>
          </div>
        </div>
      </div>
      <div className="recactions">
        <button className="textbtn" onClick={() => void seekTo(t - 10)} disabled={listening}>Back 10 s</button>
        <button className="textbtn" onClick={() => void seekTo(t + 10)} disabled={listening}>Forward 10 s</button>
        <span className="spacer" />
        <button className="textbtn" onClick={() => void save()}>Save</button>
        <button className="textbtn" onClick={() => void remove()}>Delete</button>
      </div>
      <p className="recmeta">
        {listening ? "Stop listening to play recordings · " : ""}
        {formatSize(meta.bytes)} · kept on this phone only
      </p>
    </section>
  );
}
