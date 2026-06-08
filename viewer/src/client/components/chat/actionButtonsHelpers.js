// Pure printer/slice helpers (used by CadWorkspace), split out so node:test can
// import them without JSX. Keep this file dependency-free.

export function pickPrinterForSlice(printerList, preferredId = "") {
  const list = Array.isArray(printerList) ? printerList : [];
  // An explicit user default (AppSettings.defaultPrinterId) wins whenever it
  // still matches a paired device — the user chose which device prints. A blank
  // or no-longer-paired default falls through to the auto-pick heuristic below.
  const preferred = String(preferredId || "").trim();
  if (preferred) {
    const match = list.find((p) => p && p.id === preferred);
    if (match) {
      return match;
    }
  }
  // Prefer the Bambu Studio handoff when it's set up: it's an explicit opt-in to
  // route printing through Bambu Studio, so it wins over a paired printer (a user
  // who wants direct printing simply doesn't add it). Next prefer a LAN printer —
  // the LAN upload path (FTPS to the SD card + an MQTT start command) is the
  // implemented, proven route; the cloud upload endpoint is still unverified.
  // Fall back to the first record (e.g. a cloud-only pairing) so off-LAN users
  // still get a target.
  return (
    list.find((p) => p && p.transport === "bambustudio") ||
    list.find((p) => p && p.transport === "lan") ||
    list[0] ||
    null
  );
}

export function basename(file) {
  const parts = String(file || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(file || "");
}
