// Build chat image attachments from pasted / dropped / picked files, with
// validation. Sibling to chatInputHelpers.js: small, mostly-pure, and
// unit-testable. The store + composer own the pending-attachment state; these
// are just the data helpers that turn a File/Blob into a sendable attachment.

export const MAX_ATTACHMENTS = 6;
// Matches the cap enforced server-side in commands/chat.rs.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB
// Uploads larger than this are re-encoded/shrunk down under it before sending,
// to keep chat turns light. Well under MAX_ATTACHMENT_BYTES.
export const TARGET_ATTACHMENT_BYTES = 1024 * 1024; // 1 MiB
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
  // Reject unsupported types up front; the size cap is checked after any
  // downscale, since a large upload is shrunk under TARGET_ATTACHMENT_BYTES.
  const typeCheck = validateImage(file, { maxBytes: Infinity });
  if (!typeCheck.ok) throw new Error(typeCheck.error);
  const scaled = await downscaleImageToLimit(file);
  const check = validateImage(scaled);
  if (!check.ok) throw new Error(check.error);
  const dataBase64 = await blobToBase64(scaled);
  return {
    id: nextId(),
    name: name || scaled.name || file.name || "image",
    mediaType: scaled.type,
    dataBase64,
    objectUrl:
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(scaled)
        : "",
  };
}

/**
 * Shrink an oversized image under `targetBytes` by re-encoding it as JPEG,
 * dropping quality first and then dimensions until it fits. Returns the original
 * File untouched when it's already small enough, when it can't be decoded, or
 * when no canvas is available (e.g. a non-DOM test env). Best-effort: never
 * throws — validation downstream is the real gate.
 */
export async function downscaleImageToLimit(file, { targetBytes = TARGET_ATTACHMENT_BYTES } = {}) {
  if (typeof file?.size !== "number" || file.size <= targetBytes) return file;
  if (typeof document === "undefined" && typeof OffscreenCanvas === "undefined") return file;

  let source;
  try {
    source = await loadImageBitmap(file);
  } catch {
    return file;
  }
  const srcW = source.width || 0;
  const srcH = source.height || 0;
  if (!srcW || !srcH) return file;

  const type = "image/jpeg";
  let scale = 1;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      const canvas = makeCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.drawImage(source, 0, 0, w, h);
      let quality = 0.9;
      let blob = await canvasToBlob(canvas, type, quality);
      while (blob && blob.size > targetBytes && quality > 0.4) {
        quality -= 0.15;
        blob = await canvasToBlob(canvas, type, quality);
      }
      if (blob && blob.size <= targetBytes) {
        return new File([blob], renameToJpeg(file.name), { type });
      }
      scale *= 0.75; // still too big — shrink dimensions and retry
    }
  } finally {
    source.close?.();
  }
  return file;
}

async function loadImageBitmap(blob) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function renameToJpeg(name) {
  const base = String(name || "image").replace(/\.[^.]+$/, "");
  return `${base || "image"}.jpg`;
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
