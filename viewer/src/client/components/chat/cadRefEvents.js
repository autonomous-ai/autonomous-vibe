// Tiny pub-sub bus that face/edge click handlers can publish to and the
// chat sidebar input can subscribe to. Kept module-local so we don't have to
// refactor cadjs/lib/referenceSelection.js — callers fire ref tokens here
// when they have them; the sidebar listens and pushes them onto the chat
// store's pendingTokens list.
//
// The token format is the canonical `@cad[...]` form from
// cadjs/lib/cadRefs.js. We accept a single token, a list, or a multiline
// string (clipboard-style) and split it.

import { addPendingToken } from "../../store/chat.js";

const listeners = new Set();

function normalizeTokens(input) {
  if (input == null) return [];
  const values = Array.isArray(input) ? input : String(input).split("\n");
  const out = [];
  for (const raw of values) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    // We don't strictly validate here — the chat reducer will pass them
    // through to Claude verbatim. Reject obviously non-token lines that
    // would just be noise.
    if (trimmed.startsWith("@cad[") || trimmed.includes("@cad[")) {
      out.push(trimmed);
    }
  }
  return out;
}

export function emitCadRefSelection(input) {
  const tokens = normalizeTokens(input);
  if (!tokens.length) return;
  for (const listener of listeners) {
    try {
      listener(tokens);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("cad-ref-events listener threw", error);
    }
  }
}

export function subscribeCadRefSelection(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Convenience wiring: when subscribed, pushes incoming tokens onto the chat
 * store's pendingTokens list so the sidebar input picks them up.
 */
export function bindCadRefSelectionToChatInput() {
  return subscribeCadRefSelection((tokens) => {
    for (const token of tokens) {
      addPendingToken(token);
    }
  });
}

export { normalizeTokens as __normalizeTokens };
