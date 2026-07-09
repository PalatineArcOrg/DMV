// The signature: a heartbeat monitor for a dead-man's switch. It pulses while
// the switch is armed (mint), quickens when the owner is overdue (amber), and
// flatlines once grace has elapsed / the estate is distributed (red).
export type PulseState = 'armed' | 'warn' | 'flat';

const W = 600;
const H = 96;
const BASE = 56;

// One EKG beat as (fractional-x, y-delta) points, scaled across each segment.
const BEAT: [number, number][] = [
  [0.2, 0], [0.27, -7], [0.33, 0], // P wave
  [0.4, 0], [0.44, 7], [0.49, -36], [0.53, 42], [0.57, 0], // QRS complex
  [0.66, 0], [0.74, -13], [0.82, 0], // T wave
  [1, 0],
];

function ekg(beats: number): string {
  const seg = W / beats;
  let d = `M 0 ${BASE}`;
  for (let i = 0; i < beats; i++) {
    const x = i * seg;
    for (const [fx, dy] of BEAT) d += ` L ${(x + fx * seg).toFixed(1)} ${BASE + dy}`;
  }
  return d;
}

const PATH = ekg(4);

export function Pulse({ state }: { state: PulseState }) {
  if (state === 'flat') {
    return (
      <svg className="pulse" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height="100%" aria-hidden>
        <line className="pulse-flat" x1="0" y1={BASE} x2={W} y2={BASE} />
      </svg>
    );
  }
  return (
    <svg className="pulse" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height="100%" aria-hidden>
      <path className="pulse-base" d={PATH} />
      <path className={`pulse-live ${state}`} d={PATH} />
    </svg>
  );
}
