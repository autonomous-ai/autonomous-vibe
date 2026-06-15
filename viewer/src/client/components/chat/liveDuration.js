import { useEffect, useState } from "react";
import { thinkingDurationMs, segmentDurationMs } from "@/store/chat";
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
 * Formatted duration of one segment. The active (live) segment ticks to now;
 * finished segments show their static span from per-block timestamps. Isolating
 * this in a leaf keeps the per-second re-render off the whole group (which may
 * hold streamed markdown and expanded tool rows).
 *
 * @param {import("@/store/chat").TurnSegment} segment
 * @param {boolean} active whether this is the turn's live segment
 */
export function useSegmentDuration(segment, active) {
  useSecondTick(active);
  // eslint-disable-next-line no-restricted-globals
  return formatDuration(segmentDurationMs(segment, active ? Date.now() : undefined, active));
}

/** Leaf rendering just the ticking per-segment duration string. */
export function SegmentDuration({ segment, active }) {
  return useSegmentDuration(segment, active);
}
