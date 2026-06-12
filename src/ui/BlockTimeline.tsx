/**
 * Block-based progress for a Nockchain confirmation wait. The confirmation
 * depends on the next block being MINED, not on elapsed wall-clock — so we show
 * the latest mined block (with its age) and the pending block being mined,
 * blinking. When the pending block lands, the lock confirms and the flow moves
 * on.
 */

function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function BlockTimeline({ height, ageSec }: { height: number; ageSec: number }) {
  return (
    <div className="block-timeline" aria-label="Nockchain block progress">
      <div className="blk confirmed">
        <span className="blk-num">Block {height.toLocaleString()}</span>
        <span className="blk-sub">mined {fmtAge(ageSec)} ago</span>
      </div>
      <span className="blk-arrow">→</span>
      <div className="blk pending">
        <span className="blk-num">Block {(height + 1).toLocaleString()}</span>
        <span className="blk-sub">being mined…</span>
      </div>
    </div>
  );
}
