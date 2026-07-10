"use client";

import { LogOut } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ThemeSetting from "@/components/workbench/ThemeSetting.jsx";

/**
 * Account settings, copied from panda-website's profile `SettingsDialog`
 * (`src/modules/profile/components/SettingsDialog.tsx`): an "Appearance" theme
 * picker followed by a full-width "Sign out" action. Opened from the gear
 * button in the account screen's top-right header.
 */
export default function SettingsDialog({ open, onOpenChange, onSignOut }) {
  const handleSignOut = () => {
    onOpenChange?.(false);
    onSignOut?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <fieldset className="mt-2 flex flex-col gap-3">
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Appearance
          </legend>
          <ThemeSetting />
        </fieldset>

        <button
          type="button"
          onClick={handleSignOut}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border py-3 font-semibold text-destructive transition-colors hover:bg-destructive/10"
        >
          <LogOut className="size-5" aria-hidden="true" />
          Sign out
        </button>
      </DialogContent>
    </Dialog>
  );
}
