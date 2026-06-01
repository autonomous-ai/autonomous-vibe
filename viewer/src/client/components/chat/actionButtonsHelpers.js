// Pure helpers used by ActionButtons.jsx, split out so node:test can import
// them without JSX. Keep this file dependency-free.

export function pickPrinterForSlice(printerList) {
  const list = Array.isArray(printerList) ? printerList : [];
  return list[0] || null;
}

export function basename(file) {
  const parts = String(file || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(file || "");
}
