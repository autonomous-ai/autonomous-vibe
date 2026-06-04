"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import PrinterStep from "@/components/onboarding/PrinterStep.jsx";
import FilamentStep from "@/components/onboarding/FilamentStep.jsx";

// Standalone entry point to the printer-pairing flow for users who skipped it
// during onboarding (or want to add another printer later). It replays the
// exact onboarding Printer (step 2) and Filament (step 3) screens — same step
// components, same step-label chrome — so there is a single source of truth for
// the flow; the only difference is this mounts it on demand in a dialog instead
// of inside the wizard.
const STEPS = Object.freeze(["printer", "filament"]);

const STEP_TITLES = {
  printer: "Step 1 of 2 · Printer",
  filament: "Step 2 of 2 · Filament",
};

export default function AddPrinterDialog({ open, onOpenChange, onAdded }) {
  const [step, setStep] = useState(STEPS[0]);

  // Every open starts fresh at the Printer step, regardless of where the last
  // session left off (or how it was dismissed) — opening from the menu must not
  // resume a half-finished flow.
  useEffect(() => {
    if (open) setStep(STEPS[0]);
  }, [open]);

  const close = () => onOpenChange?.(false);

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange?.(next)}>
      <DialogContent className="max-w-xl">
        {/* The step components render their own visible headings; keep a title
            here only for accessibility (Radix requires a DialogTitle). */}
        <DialogHeader className="sr-only">
          <DialogTitle>Add a printer</DialogTitle>
        </DialogHeader>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {STEP_TITLES[step]}
        </p>
        <div className="mt-3">
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
