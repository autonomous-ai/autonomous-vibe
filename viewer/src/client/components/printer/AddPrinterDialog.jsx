"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SlicerCheckStep from "@/components/onboarding/SlicerCheckStep.jsx";
import PrinterStep from "@/components/onboarding/PrinterStep.jsx";
import FilamentStep from "@/components/onboarding/FilamentStep.jsx";

// Standalone device-setup hub. Onboarding is now a single welcome+auth screen,
// so slicer / printer / filament live here instead: this dialog (reachable from
// ProjectMenu → "Add printer") replays the same step components so there is one
// source of truth for each flow. The Slicer step auto-advances when OrcaSlicer
// is already present, so an existing install is a no-op pass-through — it only
// stops to install/re-detect when the slicer is missing.
const STEPS = Object.freeze(["slicer", "printer", "filament"]);

const STEP_TITLES = {
  slicer: "Step 1 of 3 · OrcaSlicer",
  printer: "Step 2 of 3 · Printer",
  filament: "Step 3 of 3 · Filament",
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
          {step === "slicer" ? (
            <SlicerCheckStep onAdvance={() => setStep("printer")} />
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
