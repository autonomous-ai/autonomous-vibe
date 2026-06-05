// Build chat image attachments from pasted / dropped / picked files, with
// validation. Sibling to chatInputHelpers.js: small, mostly-pure, and
// unit-testable. The store + composer own the pending-attachment state; these
// are just the data helpers that turn a File/Blob into a sendable attachment.

export const MAX_ATTACHMENTS = 6;
// Matches the cap enforced server-side in commands/chat.rs.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

let counter = 0;
function nextId() {
  counter += 1;
  return globalThis.crypto?.randomUUID?.() ?? `att-${counter}-${Date.now()}`;
}

/**
 * Validate a File/Blob is an accepted image within the size cap.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateImage(file, { maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  const type = String(file?.type || "").toLowerCase();
  if (!ACCEPTED_IMAGE_TYPES.includes(type)) {
    return { ok: false, error: `Unsupported image type: ${file?.type || "unknown"}` };
  }
  if (typeof file.size === "number" && file.size > maxBytes) {
    return { ok: false, error: "Image is larger than 10 MB" };
  }
  return { ok: true };
}

/**
 * Read a File/Blob into a chat attachment: base64 data (for transport), a local
 * object URL (for an instant thumbnail), plus name + mediaType. Throws if the
 * file isn't an accepted image.
 */
export async function blobToAttachment(file, { name } = {}) {
  const check = validateImage(file);
  if (!check.ok) throw new Error(check.error);
  const dataBase64 = await blobToBase64(file);
  return {
    id: nextId(),
    name: name || file.name || "image",
    mediaType: file.type,
    dataBase64,
    objectUrl:
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : "",
  };
}

/**
 * Pull image files out of a clipboard/drag `DataTransfer`. Prefers `items`
 * (clipboard paste exposes images there, often with an empty `files`), then
 * falls back to `files` (drag-drop). Returns a possibly-empty File array.
 */
export function imageFilesFromDataTransfer(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.items && dt.items.length) {
    for (const item of dt.items) {
      if (item.kind === "file" && String(item.type || "").startsWith("image/")) {
        const file = item.getAsFile();
        if (file) out.push(file);
      }
    }
  }
  if (!out.length && dt.files && dt.files.length) {
    for (const file of dt.files) {
      if (String(file.type || "").startsWith("image/")) out.push(file);
    }
  }
  return out;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  // `btoa` exists in browsers and in Node (>=16) as a global.
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
}
