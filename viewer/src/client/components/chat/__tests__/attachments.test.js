// Tests for the chat attachment helpers: validation, blob→base64 encoding, and
// pulling image files out of a clipboard/drag DataTransfer. Runs under node:test
// (no DOM) — Blob + btoa are Node globals; URL.createObjectURL is absent there,
// so objectUrl falls back to "".

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTED_IMAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  blobToAttachment,
  imageFilesFromDataTransfer,
  validateImage,
} from "../attachments.js";

test("validateImage accepts images and rejects non-images", () => {
  assert.equal(validateImage({ type: "image/png", size: 10 }).ok, true);
  assert.equal(validateImage({ type: "image/jpeg", size: 10 }).ok, true);
  assert.equal(validateImage({ type: "text/plain", size: 10 }).ok, false);
  assert.equal(validateImage({ type: "", size: 10 }).ok, false);
});

test("validateImage rejects oversize images", () => {
  const res = validateImage({ type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 });
  assert.equal(res.ok, false);
});

test("blobToAttachment reads bytes into base64 + mediaType", async () => {
  const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
  const blob = new Blob([bytes], { type: "image/png" });
  const att = await blobToAttachment(blob, { name: "hi.png" });
  assert.equal(att.mediaType, "image/png");
  assert.equal(att.name, "hi.png");
  assert.equal(att.dataBase64, "aGVsbG8="); // base64("hello")
  assert.ok(att.id);
});

test("blobToAttachment throws on a non-image blob", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
  await assert.rejects(() => blobToAttachment(blob));
});

test("imageFilesFromDataTransfer pulls image files from files[]", () => {
  const png = new Blob([new Uint8Array([1])], { type: "image/png" });
  const txt = new Blob([new Uint8Array([1])], { type: "text/plain" });
  const files = imageFilesFromDataTransfer({ files: [png, txt] });
  assert.equal(files.length, 1);
  assert.equal(files[0].type, "image/png");
});

test("imageFilesFromDataTransfer returns empty for no transfer", () => {
  assert.deepEqual(imageFilesFromDataTransfer(null), []);
  assert.deepEqual(imageFilesFromDataTransfer({}), []);
});

test("ACCEPTED_IMAGE_TYPES includes the common formats", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    assert.ok(ACCEPTED_IMAGE_TYPES.includes(type));
  }
});
