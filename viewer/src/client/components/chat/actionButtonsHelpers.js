// Pure printer/slice helpers (used by CadWorkspace), split out so node:test can
// import them without JSX. Keep this file dependency-free.

export function pickPrinterForSlice(printerList) {
  const list = Array.isArray(printerList) ? printerList : [];
  // Prefer a LAN printer. The LAN upload path (FTPS to the SD card + an MQTT
  // start command) is the implemented, proven route; the cloud upload endpoint
  // is still unverified. When a user has both a LAN and a cloud record (they
  // have distinct ids, so both persist for the same physical printer), the LAN
  // one must win so the print uses the working transport. Fall back to the first
  // record (e.g. a cloud-only pairing) so off-LAN users still get a target.
  return list.find((p) => p && p.transport === "lan") || list[0] || null;
}

export function basename(file) {
  const parts = String(file || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(file || "");
}
