/** The ayah-end ornament: an eight-pointed star. Its outline is traced in brass as the words
 *  of the verse are heard, and it settles into verdigris once the verse is confirmed. */
const C = 50;
const R = 47;
const r = (R * Math.cos(Math.PI / 4)) / Math.cos(Math.PI / 8);
const star = Array.from({ length: 16 }, (_, i) => {
  const rad = i % 2 === 0 ? R : r;
  const a = (Math.PI / 8) * i - Math.PI / 2;
  return `${(C + rad * Math.cos(a)).toFixed(2)},${(C + rad * Math.sin(a)).toFixed(2)}`;
}).join(" ");

export function Rosette(props: { state: "idle" | "tentative" | "confirmed"; progress: number; label: string; children: React.ReactNode }) {
  const p = Math.max(0, Math.min(1, props.progress));
  return (
    <div className={`rosette ${props.state}`} role="img" aria-label={props.label}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <polygon className="seal" points={star} />
        <polygon className="frame" points={star} />
        {props.state === "tentative" && (
          <polygon className="trace" points={star} pathLength={100} strokeDasharray="100" strokeDashoffset={100 - p * 100} />
        )}
        <circle className="inner" cx={C} cy={C} r={r * 0.84} />
      </svg>
      <div className="ayah-num" aria-hidden="true">
        {props.children}
      </div>
    </div>
  );
}
