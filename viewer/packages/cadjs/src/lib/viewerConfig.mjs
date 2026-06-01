export const DEFAULT_VIEWER_GITHUB_URL = "";

export function normalizeViewerDefaultFile(value = "") {
  const rawValue = String(value ?? "").trim();
  return rawValue.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function normalizeViewerGithubUrl(value = "", fallback = DEFAULT_VIEWER_GITHUB_URL) {
  return normalizeViewerGithubUrlCandidate(value) || normalizeViewerGithubUrlCandidate(fallback);
}

function normalizeViewerGithubUrlCandidate(value = "") {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) {
    return "";
  }
  const urlValue = /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue)
    ? rawValue
    : `https://${rawValue.replace(/^\/+/, "")}`;

  try {
    const url = new URL(urlValue);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}
