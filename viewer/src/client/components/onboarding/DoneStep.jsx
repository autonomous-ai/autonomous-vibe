"use client";

import { PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DoneStep({ onFinish }) {
  return (
    <section className="flex flex-col items-center gap-4 py-6 text-center">
      <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
        <PartyPopper className="size-8" aria-hidden="true" />
      </div>
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">You're set up!</h2>
        <p className="text-sm text-muted-foreground">
          Create your first project and tell Panda what you want to print.
        </p>
      </header>
      <Button onClick={() => onFinish?.()} size="lg">
        Get started
      </Button>
    </section>
  );
}
