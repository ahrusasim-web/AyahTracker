import { useMemo, useState } from "react";
import { quranIndex } from "../core/quran/quranIndex";
import { buildPassages, type Passage } from "../core/session/passages";
import { PRIORS } from "../core/tracker/priors";
import { clearSessions, getState, loadSessions, useApp, type HistoryEntry, type SavedSession } from "../app/store";
import { deleteAllRecordings, useRecording } from "../app/recorder";
import { playRecordingFrom } from "../app/recordingPlayer";
import { seekSeconds, verseStartWall } from "../core/session/recording";
import { quranIndex as qi } from "../core/quran/quranIndex";
import { RecordingCard } from "./Recording";
import { VerseList } from "./History";
import { PassageCard } from "./PassageCard";
import { Screen } from "./Screen";
import { ChevronIcon } from "./icons";

const day = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function passagesOf(s: SavedSession): Passage[] {
  return buildPassages(s.entries);
}

function summary(ps: Passage[]): string {
  if (!ps.length) return "No verses";
  const names = ps.filter((p) => p.s !== 1).map((p) => `${quranIndex.surah(p.s)?.nameEn} ${p.from === p.to ? p.from : `${p.from}–${p.to}`}`);
  const fatihah = ps.filter((p) => p.s === 1).length;
  const parts = [...(fatihah ? [fatihah > 1 ? `Al-Fātiḥah ×${fatihah}` : "Al-Fātiḥah"] : []), ...names];
  return parts.slice(0, 3).join(" · ") + (parts.length > 3 ? ` · +${parts.length - 3} more` : "");
}

/** All saved sessions, newest first. */
export function SessionsScreen({ onBack, onOpen }: { onBack: () => void; onOpen: (startedAt: number) => void }) {
  const live = useApp((s) => s.sessionStartedAt);
  const listening = useApp((s) => s.listen === "listening");
  const [sessions, setSessions] = useState(loadSessions);
  return (
    <Screen title="Sessions" onBack={onBack}>
      {sessions.length === 0 ? (
        <p className="empty">Sessions appear here once a verse has been recognised.</p>
      ) : (
        <>
          <ul className="sessionlist">
            {sessions.map((s) => {
              const ps = passagesOf(s);
              return (
                <li key={s.startedAt}>
                  <button onClick={() => onOpen(s.startedAt)}>
                    <span className="when">
                      <b>{day(s.startedAt)}</b> {clock(s.startedAt)}
                      {PRIORS[s.prayer] && s.prayer !== "general" ? ` · ${PRIORS[s.prayer].label}` : ""}
                      {listening && live === s.startedAt ? <em> · now</em> : null}
                      {s.recorded ? <em> · recorded</em> : null}
                    </span>
                    <span className="what">{summary(ps)}</span>
                    <ChevronIcon />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="btnrow center">
            <button className="textbtn" onClick={() => { if (confirm("Delete all saved sessions and their recordings from this phone?")) { clearSessions(); void deleteAllRecordings(); setSessions([]); } }}>
              Delete all sessions
            </button>
          </div>
        </>
      )}
    </Screen>
  );
}

/** One session: its passages with English summaries, then every verse with its time. */
export function SessionScreen({ startedAt, onBack }: { startedAt: number; onBack: () => void }) {
  const liveId = useApp((s) => s.sessionStartedAt);
  const liveHistory = useApp((s) => s.history);
  const recVersion = useApp((s) => s.recVersion);
  const listening = useApp((s) => s.listen !== "idle");
  const session = useMemo(() => {
    if (liveId === startedAt) return { ...(loadSessions().find((s) => s.startedAt === startedAt) ?? {}), startedAt, prayer: getState().settings.prayer, entries: liveHistory } as SavedSession;
    return loadSessions().find((s) => s.startedAt === startedAt) ?? null;
  }, [startedAt, liveId, liveHistory, recVersion]);
  const [tab, setTab] = useState<"passages" | "verses">("passages");
  const rec = useRecording(startedAt);
  if (!session) return <Screen title="Session" onBack={onBack}><p className="empty">This session is no longer saved.</p></Screen>;
  const ps = passagesOf(session);
  const last = session.entries[session.entries.length - 1];
  const canListen = !!rec && rec.status === "done" && !listening;
  const listenAt = (e: HistoryEntry) => {
    const i = session.entries.indexOf(e);
    if (rec && i >= 0) void playRecordingFrom(startedAt, seekSeconds(verseStartWall(session.entries, i, (v) => qi.words(v)), rec));
  };
  const listenToPassage = (p: (typeof ps)[number]) => {
    const first = session.entries.filter((e) => p.entryIds.includes(e.id)).sort((a, b) => a.v.a - b.v.a)[0];
    if (first) listenAt(first);
  };
  return (
    <Screen title={`${day(session.startedAt)}, ${clock(session.startedAt)}`} onBack={onBack}>
      <p className="screen-sub">
        {session.prayer !== "general" ? `${PRIORS[session.prayer]?.label} · ` : ""}
        {session.entries.length} verses{last ? ` · until ${clock(last.wall)}` : ""}
      </p>
      <RecordingCard session={session} />
      {session.entries.length > 0 && (
      <div className="seg slim" role="tablist">
        <button role="tab" aria-pressed={tab === "passages"} onClick={() => setTab("passages")}>Passages</button>
        <button role="tab" aria-pressed={tab === "verses"} onClick={() => setTab("verses")}>Every verse</button>
      </div>
      )}
      {session.entries.length === 0 ? (
        <p className="empty">No verses were recognised in this session{rec ? ", but the recitation was recorded" : ""}.</p>
      ) : tab === "passages" ? (
        <div className="passages">{ps.map((p) => <PassageCard key={`${p.s}:${p.from}:${p.startedAt}`} p={p} onListen={canListen ? () => listenToPassage(p) : undefined} />)}</div>
      ) : (
        <>
          {canListen && <p className="listenhint">Tap a verse to replay its translation; press and hold it (or ⋯) to hear the recitation from there.</p>}
          <VerseList entries={session.entries} onListen={canListen ? listenAt : undefined} />
        </>
      )}
    </Screen>
  );
}
