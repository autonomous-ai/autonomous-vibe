import { useEffect, useState } from "react";

// Hysteresis band (px) for the pinned state. The element becomes stuck the
// moment it reaches the top, but stays stuck until it has slid a clear margin
// back below the top before unsticking. Without this buffer the state toggles
// on every sub-pixel jitter as one prompt hands off to the next — and because
// `stuck` drives a height change (the condense clamp), each toggle reflows the
// list and feeds back into more toggles: a visible flicker between two
// consecutive prompts. The asymmetric thresholds break that loop.
const STICK_PX = 0.5;
const UNSTICK_PX =50;

/**
 * Reports whether `targetRef`'s element is currently pinned to the top of the
 * `rootRef` scroll container (i.e. its `position: sticky; top: 0` has engaged).
 *
 * We compare the element's top edge against the container's top edge on scroll:
 * when pinned the two coincide, when the element is still in its natural flow
 * its top sits below the container top. A rAF guard keeps the scroll handler
 * cheap. Setting `scrollTop` programmatically (the auto-scroll-to-bottom in
 * ChatHistory) also fires `scroll`, so the state re-measures after new turns.
 * Transitions use a hysteresis band (see above) so the handoff between two
 * prompts doesn't flicker.
 *
 * Pass a null `targetRef` to disable (e.g. for non-sticky turns) — the hook is
 * still called unconditionally, it just stays `false`.
 *
 * @param {{ current: HTMLElement | null } | null} targetRef
 * @param {{ current: HTMLElement | null } | null | undefined} rootRef
 * @returns {boolean}
 */
export function useStuck(targetRef, rootRef) {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const target = targetRef?.current;
    const root = rootRef?.current;
    if (!target || !root) {
      setStuck(false);
      return undefined;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const delta =
        target.getBoundingClientRect().top - root.getBoundingClientRect().top;
      // Once stuck, hold it until the prompt has slid UNSTICK_PX below the top;
      // when free, only pin once it reaches the top. delta < 0 means the prompt
      // has been pushed up by its group ending — still stuck (sliding out).
      setStuck((prev) => (prev ? delta <= UNSTICK_PX : delta <= STICK_PX));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [targetRef, rootRef]);

  return stuck;
}
