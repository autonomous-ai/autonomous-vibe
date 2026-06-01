"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Printer, RefreshCw, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { transport } from "@/lib/transport.ts";
import { cn } from "@/ui/utils";

export default function PrinterStep({ onAdvance, onSkip }) {
  const [printers, setPrinters] = useState([]);
  const [discoveryStatus, setDiscoveryStatus] = useState("idle"); // idle | scanning | error
  const [discoveryError, setDiscoveryError] = useState("");
  const [selected, setSelected] = useState(null);
  const [accessCode, setAccessCode] = useState("");
  const [addStatus, setAddStatus] = useState("idle"); // idle | adding | error
  const [addError, setAddError] = useState("");

  const runDiscovery = useCallback(async () => {
    setDiscoveryStatus("scanning");
    setDiscoveryError("");
    try {
      const list = await transport.printer_discover();
      setPrinters(Array.isArray(list) ? list : []);
      setDiscoveryStatus("idle");
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Printer discovery failed")
          : String(err || "Printer discovery failed");
      setDiscoveryError(message);
      setDiscoveryStatus("error");
    }
  }, []);

  useEffect(() => {
    void runDiscovery();
  }, [runDiscovery]);

  const submitAccessCode = async () => {
    if (!selected) return;
    setAddStatus("adding");
    setAddError("");
    try {
      await transport.printer_add({
        ipAddress: selected.ipAddress,
        accessCode: accessCode.trim(),
        serial: selected.id,
      });
      setAddStatus("idle");
      setSelected(null);
      setAccessCode("");
      onAdvance?.();
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message || "Could not pair with the printer")
          : String(err || "Could not pair with the printer");
      setAddError(message);
      setAddStatus("error");
    }
  };

  const scanning = discoveryStatus === "scanning";
  const accessCodeValid = accessCode.trim().length >= 4;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">Add your Bambu printer</h2>
        <p className="text-sm text-muted-foreground">
          Panda finds Bambu printers on your local network. Pick yours and
          enter the access code from the printer screen.
        </p>
      </header>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runDiscovery()}
          disabled={scanning}
          data-testid="printer-step-rescan"
        >
          {scanning ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 size-4" />
          )}
          Scan local network
        </Button>
        {discoveryError ? (
          <p className="text-sm text-destructive" role="alert">
            {discoveryError}
          </p>
        ) : null}
      </div>
      {scanning && printers.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          Looking for printers on your network…
        </div>
      ) : null}
      {!scanning && printers.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm">
          <p className="font-medium">No printers found yet.</p>
          <p className="mt-1 text-muted-foreground">
            Make sure your Bambu printer is on, connected to the same Wi-Fi,
            and that LAN mode is enabled in its settings. Then click “Scan
            local network” again.
          </p>
        </div>
      ) : null}
      <ul className="grid gap-2">
        {printers.map((printer) => (
          <li key={printer.id}>
            <button
              type="button"
              className={cn(
                "flex w-full items-start gap-3 rounded-md border border-border p-3 text-left transition-colors",
                "hover:border-primary hover:bg-muted/40",
                selected?.id === printer.id ? "border-primary bg-muted/60" : "",
              )}
              onClick={() => {
                setSelected(printer);
                setAccessCode("");
                setAddError("");
                setAddStatus("idle");
              }}
            >
              <Printer className="mt-0.5 size-5 text-muted-foreground" />
              <span className="flex flex-1 flex-col">
                <span className="font-medium">{printer.model || "Bambu printer"}</span>
                <span className="text-xs text-muted-foreground">
                  {printer.hostName || printer.id} · {printer.ipAddress}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSkip?.()}
          data-testid="printer-step-skip"
        >
          <SkipForward className="mr-2 size-4" /> Skip for now
        </Button>
        <p className="text-xs text-muted-foreground">
          You can add a printer later from Settings.
        </p>
      </div>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(next) => {
          if (!next && addStatus !== "adding") {
            setSelected(null);
            setAccessCode("");
            setAddError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pair with {selected?.model || "printer"}</DialogTitle>
            <DialogDescription>
              Open the printer screen → Settings → Wi-Fi to see the LAN access
              code, then enter it below.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (accessCodeValid && addStatus !== "adding") {
                void submitAccessCode();
              }
            }}
            className="space-y-2"
          >
            <Input
              autoFocus
              placeholder="Access code"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              aria-label="Access code"
              inputMode="numeric"
              disabled={addStatus === "adding"}
            />
            {addError ? (
              <p className="text-sm text-destructive" role="alert">
                {addError}
              </p>
            ) : null}
          </form>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                if (addStatus !== "adding") {
                  setSelected(null);
                  setAccessCode("");
                }
              }}
              disabled={addStatus === "adding"}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitAccessCode()}
              disabled={!accessCodeValid || addStatus === "adding"}
            >
              {addStatus === "adding" ? "Pairing…" : "Pair printer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
