"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Cloud,
  Loader2,
  LogOut,
  Printer,
  RefreshCw,
  SkipForward,
  Wifi,
} from "lucide-react";
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

function errMessage(err, fallback) {
  return err && typeof err === "object" && "message" in err
    ? String(err.message || fallback)
    : String(err || fallback);
}

export default function PrinterStep({ onAdvance, onSkip }) {
  // "lan" pairs over the local network; "cloud" signs in to a Bambu account
  // and reaches printers through Bambu's cloud (works off-LAN).
  const [mode, setMode] = useState("lan");

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">Add your Bambu printer</h2>
        <p className="text-sm text-muted-foreground">
          Pair over your local network, or sign in to Bambu Cloud to reach
          your printers from anywhere.
        </p>
      </header>

      <div className="inline-flex w-fit rounded-md border border-border p-0.5">
        <button
          type="button"
          onClick={() => setMode("lan")}
          className={cn(
            "flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors",
            mode === "lan" ? "bg-muted font-medium" : "text-muted-foreground",
          )}
          data-testid="printer-mode-lan"
        >
          <Wifi className="size-4" /> Local network
        </button>
        <button
          type="button"
          onClick={() => setMode("cloud")}
          className={cn(
            "flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors",
            mode === "cloud" ? "bg-muted font-medium" : "text-muted-foreground",
          )}
          data-testid="printer-mode-cloud"
        >
          <Cloud className="size-4" /> Bambu Cloud
        </button>
      </div>

      {mode === "lan" ? (
        <LanPairing onAdvance={onAdvance} />
      ) : (
        <CloudPairing onAdvance={onAdvance} />
      )}

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
    </section>
  );
}

// ---------------------------------------------------------------------------
// LAN pairing (original flow)
// ---------------------------------------------------------------------------

function LanPairing({ onAdvance }) {
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
      setDiscoveryError(errMessage(err, "Printer discovery failed"));
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
      setAddError(errMessage(err, "Could not pair with the printer"));
      setAddStatus("error");
    }
  };

  const scanning = discoveryStatus === "scanning";
  const accessCodeValid = accessCode.trim().length >= 4;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Panda finds Bambu printers on your local network. Pick yours and enter
        the access code from the printer screen.
      </p>
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
            and that LAN mode is enabled in its settings. Then click “Scan local
            network” again.
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cloud pairing (Bambu account sign-in → bound devices)
// ---------------------------------------------------------------------------

function CloudPairing({ onAdvance }) {
  // phase: "email" (enter email) → "code" (enter emailed code) → "signedIn"
  const [phase, setPhase] = useState("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [account, setAccount] = useState("");
  const [printers, setPrinters] = useState([]);
  const [discovering, setDiscovering] = useState(false);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setError("");
    try {
      const list = await transport.printer_discover_cloud();
      setPrinters(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(errMessage(err, "Could not list cloud printers"));
    } finally {
      setDiscovering(false);
    }
  }, []);

  // On mount, reflect an existing signed-in session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await transport.cloud_account_status();
        if (cancelled) return;
        if (status?.signedIn && !status.needsReauth) {
          setAccount(status.account || "");
          setPhase("signedIn");
          void discover();
        }
      } catch {
        /* not signed in — stay on the email phase */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discover]);

  const sendCode = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setError("");
    try {
      await transport.cloud_login_request_code({ account: email.trim() });
      setPhase("code");
    } catch (err) {
      setError(errMessage(err, "Could not send the verification code"));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const status = await transport.cloud_login_submit_code({
        account: email.trim(),
        code: code.trim(),
      });
      setAccount(status?.account || email.trim());
      setCode("");
      setPhase("signedIn");
      void discover();
    } catch (err) {
      setError(errMessage(err, "That code was not accepted"));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await transport.cloud_logout();
    } catch {
      /* best-effort */
    } finally {
      setBusy(false);
      setAccount("");
      setPrinters([]);
      setPhase("email");
    }
  };

  if (phase === "signedIn") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 p-3">
          <span className="text-sm">
            Signed in as <span className="font-medium">{account}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => void signOut()} disabled={busy}>
            <LogOut className="mr-2 size-4" /> Sign out
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void discover()}
            disabled={discovering}
            data-testid="printer-cloud-rescan"
          >
            {discovering ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 size-4" />
            )}
            Refresh printers
          </Button>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        {!discovering && printers.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No printers are bound to this Bambu account yet.
          </div>
        ) : null}
        <ul className="grid gap-2">
          {printers.map((printer) => (
            <li key={printer.id}>
              <button
                type="button"
                className="flex w-full items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:border-primary hover:bg-muted/40"
                onClick={() => onAdvance?.()}
              >
                <Cloud className="mt-0.5 size-5 text-muted-foreground" />
                <span className="flex flex-1 flex-col">
                  <span className="font-medium">{printer.model || "Bambu printer"}</span>
                  <span className="text-xs text-muted-foreground">
                    {printer.hostName || printer.id}
                    {printer.online === false ? " · offline" : " · online"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (phase === "email") void sendCode();
        else void signIn();
      }}
    >
      <p className="text-sm text-muted-foreground">
        We’ll email a 6-digit verification code to your Bambu account.
      </p>
      <Input
        type="email"
        autoFocus
        placeholder="Bambu account email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        aria-label="Bambu account email"
        disabled={busy || phase === "code"}
      />
      {phase === "code" ? (
        <Input
          placeholder="Verification code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-label="Verification code"
          inputMode="numeric"
          autoFocus
          disabled={busy}
        />
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {phase === "code" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setPhase("email");
              setCode("");
              setError("");
            }}
            disabled={busy}
          >
            Back
          </Button>
        ) : null}
        <Button type="submit" disabled={busy || (phase === "email" ? !email.trim() : !code.trim())}>
          {busy ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : null}
          {phase === "email" ? "Send code" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}
