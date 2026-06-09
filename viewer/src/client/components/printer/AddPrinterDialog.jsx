"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { transport } from "@/lib/transport.ts";
import { evaluateSlicerCheck } from "@/components/onboarding/onboardingHelpers.js";
import SlicerCheckStep from "@/components/onboarding/SlicerCheckStep.jsx";
import PrinterStep from "@/components/onboarding/PrinterStep.jsx";
import FilamentStep from "@/components/onboarding/FilamentStep.jsx";

// Standalone device-setup hub. Onboarding is now a single welcome+auth screen,
// so slicer / printer / filament live here instead: this dialog (reachable from
// ProjectMenu → "Add printer") replays the same step components so there is one
// source of truth for each flow.
//
// OrcaSlicer detection runs *silently in the background*. The dialog opens
// instantly on the Printer step — no "Checking…" card, no "Preparing…"
// placeholder, no waiting on detection. The check resolves a moment later: when
// the slicer is already installed (the common case) nothing changes; only when
// it's actually missing do we drop in the slicer step and steer the user there.
// Step numbering ("Step N of M") is derived from the resulting step list so the
// common case reads as a clean 2-step flow.
const STEP_LABELS = Object.freeze({
  slicer: "OrcaSlicer",
  printer: "Printer",
  filament: "Filament",
});

function stepTitle(step, steps) {
  const index = steps.indexOf(step);
  return `Step ${index + 1} of ${steps.length} · ${STEP_LABELS[step]}`;
}

export default function AddPrinterDialog({ open, onOpenChange, onAdded }) {
  // false = slicer missing (slicer step inserted); true/optimistic = assume
  // present so the dialog can open instantly without waiting on detection.
  const [slicerReady, setSlicerReady] = useState(true);
  const [step, setStep] = useState("printer");

  useEffect(() => {
    // Reset on close so the next open starts fresh on the Printer step instead of
    // resuming a half-finished flow (or flashing the previous flow's last step).
    if (!open) {
      setSlicerReady(true);
      setStep("printer");
      return;
    }
    let cancelled = false;
    // Verify the slicer in the background; only act if it's actually missing.
    (async () => {
      let ready = true;
      try {
        const check = await transport.app_prereq_check();
        ready = evaluateSlicerCheck(check).proceed;
      } catch {
        // Treat a detection failure as "needs setup" so the user can recover via
        // the install card rather than silently hitting a slice failure later.
        ready = false;
      }
      if (cancelled || ready) return;
      setSlicerReady(false);
      // Steer to the slicer step, but only if the user hasn't already moved on.
      setStep((current) => (current === "printer" ? "slicer" : current));
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const close = () => onOpenChange?.(false);

  const steps = slicerReady
    ? ["printer", "filament"]
    : ["slicer", "printer", "filament"];

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange?.(next)}>
      <DialogContent className="max-w-xl">
        {/* The step components render their own visible headings; keep a title
            here only for accessibility (Radix requires a DialogTitle). */}
        <DialogHeader className="sr-only">
          <DialogTitle>Add a printer</DialogTitle>
        </DialogHeader>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {stepTitle(step, steps)}
        </p>
        <div className="mt-3">
          {step === "slicer" ? (
            <SlicerCheckStep
              initialStatus="missing"
              onAdvance={() => setStep("printer")}
            />
          ) : null}
          {step === "printer" ? (
            <PrinterStep
              onAdvance={() => {
                onAdded?.();
                setStep("filament");
              }}
              onSkip={() => setStep("filament")}
            />
          ) : null}
          {step === "filament" ? (
            <FilamentStep onAdvance={() => close()} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
