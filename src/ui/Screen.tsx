import { useEffect, useRef } from "react";
import { BackIcon } from "./icons";

/**
 * A full-page view with a back button. It adds one browser-history entry when it opens, so the
 * phone's back gesture (and Escape) returns to the previous view instead of leaving the app.
 */
export function Screen({ title, onBack, children, actions }: { title: string; onBack: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    history.pushState({ ayahScreen: true }, "");
    const onPop = () => back.current();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && history.back();
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    window.scrollTo(0, 0);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div className="screen">
      <div className="screenbar">
        <button className="iconbtn" onClick={() => history.back()} aria-label="Back">
          <BackIcon />
        </button>
        <h2>{title}</h2>
        <div className="screenbar-actions">{actions}</div>
      </div>
      {children}
    </div>
  );
}
