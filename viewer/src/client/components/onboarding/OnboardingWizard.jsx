"use client";

import { useCallback, useState } from "react";
import { transport } from "@/lib/transport.ts";
import ClaudeCheckStep from "./ClaudeCheckStep.jsx";
import ClaudeLoginStep from "./ClaudeLoginStep.jsx";
import SlicerCheckStep from "./SlicerCheckStep.jsx";
import PrinterStep from "./PrinterStep.jsx";
import FilamentStep from "./FilamentStep.jsx";
import DoneStep from "./DoneStep.jsx";
import {
  ONBOARDING_STEPS,
  nextOnboardingStep,
} from "./onboardingHelpers.js";

const STEP_TITLES = {
  claude: "Step 1 of 5 · Claude Code",
  login: "Step 2 of 5 · Sign in",
  orca: "Step 3 of 5 · OrcaSlicer",
  printer: "Step 4 of 5 · Printer",
  filament: "Step 5 of 5 · Filament",
  done: "All set",
};

export default function OnboardingWizard({ onComplete }) {
  const [step, setStep] = useState(ONBOARDING_STEPS[0]);
  const [settings, setSettings] = useState(null);
  const [finishing, setFinishing] = useState(false);

  const advance = useCallback(() => {
    setStep((current) => nextOnboardingStep(current));
  }, []);

  const finish = useCallback(async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      // Re-read rather than trust the in-memory copy: the sign-in step
      // persisted `claudeOauthToken` straight to settings, so an older
      // `settings` snapshot would clobber it on write.
      const existing = await transport.app_settings_read();
      const nextSettings = {
        defaultFilament: existing?.defaultFilament ?? "PLA",
        slicerBinaryPath: existing?.slicerBinaryPath ?? "",
        usePandaCloud: existing?.usePandaCloud ?? false,
        pandaToken: existing?.pandaToken,
        claudeOauthToken: existing?.claudeOauthToken,
        hasOnboarded: true,
        autoUpdate: existing?.autoUpdate ?? false,
      };
      await transport.app_settings_write(nextSettings);
      onComplete?.(nextSettings);
    } catch (err) {
      console.warn("Failed to persist onboarding completion", err);
      // Still let the user into the app — they can re-onboard from Settings.
      onComplete?.(settings || null);
    } finally {
      setFinishing(false);
    }
  }, [finishing, onComplete, settings]);

  return (
    <div
      role="dialog"
      aria-label="Welcome to Panda"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4"
    >
      <div className="w-full max-w-xl rounded-lg border border-border bg-background p-6 shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {STEP_TITLES[step]}
        </p>
        <div className="mt-3">
          {step === "claude" ? <ClaudeCheckStep onAdvance={advance} /> : null}
          {step === "login" ? <ClaudeLoginStep onAdvance={advance} /> : null}
          {step === "orca" ? <SlicerCheckStep onAdvance={advance} /> : null}
          {step === "printer" ? (
            <PrinterStep onAdvance={advance} onSkip={advance} />
          ) : null}
          {step === "filament" ? (
            <FilamentStep
              currentSettings={settings}
              onAdvance={(nextSettings) => {
                setSettings(nextSettings);
                advance();
              }}
            />
          ) : null}
          {step === "done" ? <DoneStep onFinish={() => void finish()} /> : null}
        </div>
      </div>
    </div>
  );
}
