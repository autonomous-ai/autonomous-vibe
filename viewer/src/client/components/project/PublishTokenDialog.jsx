"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { transport } from "@/lib/transport.ts";

/**
 * Prompt for a panda-social token. Opened when a publish returns
 * `SOCIAL_TOKEN_REQUIRED` (no token, or the saved one expired). The pasted value
 * may be a bare refresh-token JWT or the web app's sign-in JSON — the Rust side
 * validates it against the refresh endpoint before saving. On success calls
 * `onSaved()` so the caller can retry the publish.
 */
export default function PublishTokenDialog({ open, onOpenChange, onSaved }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = (next) => {
    if (busy) return;
    if (!next) {
      setValue("");
      setError("");
    }
    onOpenChange?.(next);
  };

  const handleSave = async () => {
    const token = value.trim();
    if (!token || busy) return;
    setBusy(true);
    setError("");
    try {
      await transport.social_set_token(token);
      setBusy(false);
      setValue("");
      onOpenChange?.(false);
      onSaved?.();
    } catch (err) {
      setBusy(false);
      setError(err?.message || "That token was rejected. Paste a current token and try again.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Sign in to panda-social</DialogTitle>
          <DialogDescription>
            Publishing needs your panda-social access token. Paste your{" "}
            <strong>refresh token</strong> (or the whole sign-in JSON from the web app) below —
            it's validated and saved on this device so you won't be asked again until it expires.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder='eyJhbGciOi… — or {"state":{"refreshToken":"eyJ…"}}'
          rows={5}
          spellCheck={false}
          autoFocus
          className="font-mono text-xs break-all"
          disabled={busy}
        />

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={busy || !value.trim()}>
            {busy ? "Validating…" : "Save & publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
