import {
  DEFAULT_VIEWER_ROOT_DIR,
  normalizeViewerRootDir,
} from "cadjs/lib/cadDirectoryScanner.mjs";

export const VIEWER_ASSET_BACKENDS = Object.freeze({
  LOCAL_FS: "local-fs",
  VERCEL_BLOB: "vercel-blob",
});

const VALID_VIEWER_ASSET_BACKENDS = new Set(Object.values(VIEWER_ASSET_BACKENDS));

export function envValue(env, name, fallback = "") {
  return String(env?.[name] ?? fallback).trim();
}

export function normalizeViewerAssetBackend(value, fallback = VIEWER_ASSET_BACKENDS.LOCAL_FS) {
  const normalized = String(value || fallback || "").trim().toLowerCase();
  if (VALID_VIEWER_ASSET_BACKENDS.has(normalized)) {
    return normalized;
  }
  throw new Error(
    `Unsupported VIEWER_ASSET_BACKEND: ${normalized || "(missing)"}. ` +
    `Expected one of: ${[...VALID_VIEWER_ASSET_BACKENDS].join(", ")}.`
  );
}

export function localRootDirFromEnv(env = process.env) {
  return normalizeViewerRootDir(envValue(env, "VIEWER_LOCAL_ROOT_DIR", DEFAULT_VIEWER_ROOT_DIR));
}

export function rootDirForAssetBackend(assetBackend, env = process.env) {
  return assetBackend === VIEWER_ASSET_BACKENDS.LOCAL_FS
    ? localRootDirFromEnv(env)
    : DEFAULT_VIEWER_ROOT_DIR;
}

export function vercelBlobCatalogUrlFromPrefix(prefix) {
  const rawPrefix = envValue({ prefix }, "prefix");
  if (!rawPrefix) {
    return "";
  }
  try {
    const url = new URL(rawPrefix);
    const pathname = url.pathname.replace(/^\/+|\/+$/g, "");
    url.pathname = `/${[pathname, "catalog.json"].filter(Boolean).join("/")}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function vercelBlobConfigFromEnv(env = process.env) {
  const prefix = envValue(env, "VIEWER_VERCEL_BLOB_PREFIX");
  return {
    prefix,
    catalogPath: "catalog.json",
    catalogUrl: vercelBlobCatalogUrlFromPrefix(prefix),
    token: envValue(env, "VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN") || undefined,
  };
}
