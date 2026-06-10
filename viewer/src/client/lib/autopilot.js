import { useEffect, useState } from "react";
import { getTransport } from "@/lib/transport";

// Module-cached so every PlanBlock / QuestionCard doesn't re-read settings.
// `undefined` = not yet loaded; default to autopilot ON (the product default).
let cached;

/**
 * Whether the app is in autopilot (`auto_build`): no plan-approval gate, the
 * build runs to completion automatically. Reads `app_settings_read()` once and
 * caches it. Defaults to `true` (matching the Rust `AppSettings` default) so the
 * UI behaves correctly even before the fetch resolves.
 *
 * @returns {boolean}
 */
export function useAutopilot() {
  const [autopilot, setAutopilot] = useState(cached ?? true);
  useEffect(() => {
    if (cached !== undefined) return;
    let alive = true;
    getTransport()
      .app_settings_read()
      .then((s) => {
        cached = s?.autoBuild !== false; // absent/true → autopilot
        if (alive) setAutopilot(cached);
      })
      .catch(() => {
        /* keep the optimistic default */
      });
    return () => {
      alive = false;
    };
  }, []);
  return autopilot;
}
