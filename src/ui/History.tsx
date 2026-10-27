import { useEffect, useRef, useState } from "react";
import { quranIndex } from "../core/quran/quranIndex";
import { playback } from "../app/audio";
import { hasSurahClip } from "../app/library";
import { notify, useApp, type HistoryEntry } from "../app/store";
import { MoreIcon } from "./icons";

const fmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

interface MenuState {
  entry: HistoryEntry;
  x: number;
  y: number;
}

export function History() {
  const history = useApp((s) => s.history);
  const current = useApp((s) => s.playback.current);
  const listen = useApp((s) => s.listen);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const rows = [...history].reverse();

  return (
    <section className="history" aria-label="Verses heard this session">
      <h2>
        Heard this session {history.length > 0 && <span>{history.length} {history.length === 1 ? "verse" : "verses"} · tap to replay</span>}
      </h2>
      {rows.length === 0 ? (
        <p className="empty">
          {listen === "listening" ? "Confirmed verses will appear here as they are recited." : <>Press <b>Start listening</b> when the recitation begins.</>}
        </p>
      ) : (
        <ol>
          {rows.map((h) => (
            <Row key={h.id} entry={h} playing={current?.entryId === h.id} onMenu={(x, y) => setMenu({ entry: h, x, y })} />
          ))}
        </ol>
      )}
      {menu && <EntryMenu {...menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

function Row({ entry, playing, onMenu }: { entry: HistoryEntry; playing: boolean; onMenu: (x: number, y: number) => void }) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const surah = quranIndex.surah(entry.v.s);

  const start = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    longPressed.current = false;
    const { clientX: x, clientY: y } = e;
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      navigator.vibrate?.(12);
      onMenu(x, y);
    }, 480);
  };
  const cancel = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <li className={`row${playing ? " playing-row" : ""}`}>
      <button
        className="main"
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
          onMenu(e.clientX, e.clientY);
        }}
        onClick={() => {
          if (longPressed.current) return;
          playback.playManual(entry.id, entry.v, "ayah");
        }}
        aria-label={`${surah?.nameEn} ${entry.v.s}:${entry.v.a} at ${fmt(entry.wall)}. Replay translation.`}
      >
        <span className="time">{fmt(entry.wall)}</span>
        <span className="ref">
          {entry.v.s}:{entry.v.a}
        </span>
        <span className="name">
          {surah?.nameEn}
          {entry.ambiguousWith?.length ? <em> · same words in {entry.ambiguousWith.length} other places</em> : null}
        </span>
      </button>
      <button className="iconbtn more" aria-label={`More for ${entry.v.s}:${entry.v.a}`} onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onMenu(r.right, r.bottom);
      }}>
        <MoreIcon />
      </button>
    </li>
  );
}

function EntryMenu({ entry, x, y, onClose }: MenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const surah = quranIndex.surah(entry.v.s);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos({ left: Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8)), top: Math.max(8, Math.min(y, window.innerHeight - h - 8)) });
    el.querySelector("button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [x, y, onClose]);

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="menu" ref={ref} role="menu" style={pos} aria-label={`${surah?.nameEn} ${entry.v.s}:${entry.v.a}`}>
        <h3>
          {surah?.nameEn} · {entry.v.s}:{entry.v.a}
        </h3>
        <button role="menuitem" onClick={act(() => playback.playManual(entry.id, entry.v, "ayah"))}>
          Play this verse's translation
        </button>
        <button role="menuitem" disabled={!hasSurahClip(entry.v.s)} onClick={act(() => playback.playManual(entry.id, entry.v, "surah"))}>
          Play full surah translation ({entry.v.s}.mp3)
        </button>
        <button
          role="menuitem"
          onClick={act(() => {
            void navigator.clipboard?.writeText(`${surah?.nameEn} ${entry.v.s}:${entry.v.a}`).then(() => notify("Reference copied."));
          })}
        >
          Copy reference
        </button>
      </div>
    </>
  );
}
