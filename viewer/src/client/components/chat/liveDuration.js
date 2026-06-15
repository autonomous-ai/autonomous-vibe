import { useEffect, useState } from "react";
import { thinkingDurationMs } from "@/store/chat";
import { formatDuration } from "./activityLabels";

// Re-render every second while `running`, so a duration leaf ticks live.
function useSecondTick(running) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
}

/**
 * Formatted whole-turn duration that ticks while the turn runs. Used for the
 * startup heartbeat (before any segment has formed) so a just-started turn
 * still shows a moving counter and never looks stuck.
 *
 * @param {{status?: string, startedAt?: number}} turn
 */
export function useLiveDuration(turn) {
  useSecondTick(turn?.status === "running");
  return formatDuration(thinkingDurationMs(turn));
}

/** Leaf rendering just the ticking whole-turn duration string. */
export function LiveDuration({ turn }) {
  return useLiveDuration(turn);
}

/**
 * Formatted duration of one segment from its contiguous [start, end] span (see
 * `segmentSpans`). The active (live) segment counts to now and ticks; finished
 * segments show their static span. Isolating this in a leaf keeps the
 * per-second re-render off the whole group (which may hold streamed markdown and
 * expanded tool rows).
 *
 * @param {number} start span start (epoch ms)
 * @param {number} end span end (epoch ms); ignored when `active`
 * @param {boolean} active whether this is the turn's live segment
 */
export function useSpanDuration(start, end, active) {
  useSecondTick(active);
  const from = typeof start === "number" ? start : 0;
  // eslint-disable-next-line no-restricted-globals
  const to = active ? Date.now() : typeof end === "number" ? end : from;
  return formatDuration(Math.max(0, to - from));
}

/** Leaf rendering just the ticking per-segment duration string. */
export function SpanDuration({ start, end, active }) {
  return useSpanDuration(start, end, active);
}
