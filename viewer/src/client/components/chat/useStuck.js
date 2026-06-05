import { useEffect, useState } from "react";

/**
 * Reports whether a sticky element is currently pinned to the top of the
 * `rootRef` scroll container, by observing a zero-impact sentinel placed at the
 * pinned element's natural top position (just above it, in normal flow).
 *
 * While any part of the sentinel is within the scrollport the element sits in
 * its natural flow; once the sentinel clears the container's top edge the
 * element's `position: sticky` has engaged — so `!isIntersecting` is exactly
 * "stuck". Because the sentinel sits ABOVE the pinned element and is positioned
 * independently of it, condensing the pinned element (a height change) never
 * moves the sentinel. That removes the height→reflow→re-measure feedback loop
 * the old scroll-measurement approach had, so no hysteresis band is needed and
 * tall prompts (whose condense delta used to exceed the band) no longer
 * flicker. IntersectionObserver also doesn't re-fire on every scroll tick, so
 * the auto-scroll-to-bottom during streaming no longer churns the state.
 *
 * Pass a null `sentinelRef` to disable (non-sticky turns) — the hook is still
 * called unconditionally, it just stays `false`.
 *
 * @param {{ current: HTMLElement | null } | null} sentinelRef
 * @param {{ current: HTMLElement | null } | null | undefined} rootRef
 * @returns {boolean}
 */
export function useStuck(sentinelRef, rootRef) {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef?.current;
    const root = rootRef?.current;
    if (!sentinel || !root) {
      setStuck(false);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setStuck(!entry.isIntersecting);
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinelRef, rootRef]);

  return stuck;
}
