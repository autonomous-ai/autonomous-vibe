"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AppWindow,
  Check,
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
  // "lan" pairs over the local network; "studio" skips pairing entirely and
  // hands models off to the local Bambu Studio app. The Bambu Cloud option is
  // hidden for now — CloudPairing below is left in place to re-enable it.
  const [mode, setMode] = useState("lan");

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">Add your Bambu printer</h2>
        <p className="text-sm text-muted-foreground">
          Pair over your local network, or hand models off to Bambu Studio.
        </p>
      </header>

      <DefaultDeviceSection />

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
          onClick={() => setMode("studio")}
          className={cn(
            "flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors",
            mode === "studio" ? "bg-muted font-medium" : "text-muted-foreground",
          )}
          data-testid="printer-mode-studio"
        >
          <AppWindow className="size-4" /> Bambu Studio
        </button>
      </div>

      {mode === "lan" ? <LanPairing onAdvance={onAdvance} /> : null}
      {mode === "studio" ? <StudioHandoff onAdvance={onAdvance} /> : null}

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
// Default device (Settings): pick which paired device the Print action targets
// ---------------------------------------------------------------------------
//
// Lists the devices already paired (LAN, cloud, and the Bambu Studio handoff)
// and lets the user mark one as the default. The choice persists to
// AppSettings.defaultPrinterId; the viewer's Print action prefers it whenever it
// still matches a paired device (see pickPrinterForSlice). Hidden until at least
// one device is paired — with none there is nothing to choose.

const DEVICE_ICONS = { lan: Wifi, cloud: Cloud, bambustudio: AppWindow };

function deviceTransportLabel(transport) {
  switch (transport) {
    case "lan":
      return "Local network";
    case "cloud":
      return "Bambu Cloud";
    case "bambustudio":
      return "Bambu Studio";
    default:
      return "Printer";
  }
}

function DefaultDeviceSection() {
  const [devices, setDevices] = useState([]);
  const [defaultId, setDefaultId] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, settings] = await Promise.all([
          transport.printer_list(),
          transport.app_settings_read(),
        ]);
        if (cancelled) return;
        setDevices(Array.isArray(list) ? list : []);
        setDefaultId(String(settings?.defaultPrinterId || ""));
      } catch (err) {
        if (!cancelled) setError(errMessage(err, "Could not load your devices"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (id) => {
    // Toggle: picking the current default clears it (back to auto-pick).
    const next = id === defaultId ? "" : id;
    const previous = defaultId;
    setSavingId(id);
    setError("");
    setDefaultId(next); // optimistic
    try {
      // Read-modify-write the whole settings object so we never drop sibling
      // fields (slicer profiles, auth tokens, autoUpdate, …).
      const existing = await transport.app_settings_read();
      await transport.app_settings_write({ ...existing, defaultPrinterId: next });
    } catch (err) {
      setDefaultId(previous); // revert on failure
      setError(errMessage(err, "Could not save your default device"));
    } finally {
      setSavingId("");
    }
  };

  // Nothing to choose yet — keep the add-a-printer flow uncluttered.
  if (loading || devices.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">Default print device</h3>
        <p className="text-xs text-muted-foreground">
          Print sends sliced models here. Pick the current default again to clear
          it and let Panda choose automatically.
        </p>
      </div>
      <div role="radiogroup" aria-label="Default print device" className="grid gap-2">
        {devices.map((device) => {
          const Icon = DEVICE_ICONS[device.transport] || Printer;
          const active = device.id === defaultId;
          const busy = savingId === device.id;
          return (
            <button
              key={device.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={Boolean(savingId)}
              onClick={() => void choose(device.id)}
              className={cn(
                "flex items-center gap-3 rounded-md border border-border bg-background p-2.5 text-left transition-colors disabled:opacity-60",
                active ? "border-primary bg-primary/5" : "hover:border-primary/60 hover:bg-muted/40",
              )}
              data-testid={`default-device-${device.id}`}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border",
                  active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                )}
                aria-hidden="true"
              >
                {busy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : active ? (
                  <Check className="size-3" />
                ) : null}
              </span>
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex flex-1 flex-col">
                <span className="text-sm font-medium">{device.model || "Bambu printer"}</span>
                <span className="text-xs text-muted-foreground">
                  {deviceTransportLabel(device.transport)}
                  {device.hostName ? ` · ${device.hostName}` : ""}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bambu Studio handoff (no pairing — opens the model in the local app)
// ---------------------------------------------------------------------------

function StudioHandoff({ onAdvance }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const use = async () => {
    setBusy(true);
    setError("");
    try {
      await transport.printer_add_studio();
      onAdvance?.();
    } catch (err) {
      setError(errMessage(err, "Could not set up Bambu Studio"));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Skip pairing and hand your model off to Bambu Studio instead. When you
        press Print, Panda opens the model in Bambu Studio so you can slice and
        send it to your printer from there. Requires Bambu Studio to be
        installed.
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          onClick={() => void use()}
          disabled={busy}
          data-testid="printer-studio-use"
        >
          {busy ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <AppWindow className="mr-2 size-4" />
          )}
          Use Bambu Studio
        </Button>
      </div>
    </div>
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
// Cloud pairing (Bambu account email+password → auto-pulled printers)
// ---------------------------------------------------------------------------
//
// Sign in to Bambu Cloud with email + password, then auto-pull the account's
// printers from the cloud "bind list" (`printer_discover_cloud` → GET /user/bind),
// which already carries each printer's serial + access code — so the user never
// types them. A returning, already-signed-in user lands straight on the list.

function CloudPairing({ onAdvance }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // Bambu often requires an emailed code as a second factor after the password;
  // when it does, the form switches to collecting that code.
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signedInAccount, setSignedInAccount] = useState("");
  const [printers, setPrinters] = useState([]);
  const [discovering, setDiscovering] = useState(false);

  // Pull the account's bound printers. Each is persisted by the backend on
  // discovery (serial + access code included), so selecting one just advances.
  const discover = useCallback(async () => {
    setDiscovering(true);
    setError("");
    try {
      const list = await transport.printer_discover_cloud();
      setPrinters(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(errMessage(err, "Could not list your printers"));
    } finally {
      setDiscovering(false);
    }
  }, []);

  // Reflect an existing session: skip the password step straight to the list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await transport.cloud_account_status();
        if (cancelled) return;
        if (status?.signedIn && !status.needsReauth) {
          setSignedInAccount(status.account || "");
          void discover();
        }
      } catch {
        /* not signed in — show the email/password fields */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discover]);

  const signIn = async () => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const challenge = await transport.cloud_login_password({
        account: email.trim(),
        password,
      });
      if (challenge?.kind === "success") {
        setSignedInAccount(email.trim());
        setPassword("");
        void discover();
      } else if (challenge?.kind === "codeSent") {
        // Bambu emailed a verification code — collect it to finish sign-in.
        setAwaitingCode(true);
      } else {
        setError("Sign-in could not be completed.");
      }
    } catch (err) {
      setError(errMessage(err, "Email or password was not accepted"));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const status = await transport.cloud_login_submit_code({
        account: email.trim(),
        code: code.trim(),
      });
      setSignedInAccount(status?.account || email.trim());
      setCode("");
      setAwaitingCode(false);
      setPassword("");
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
      setSignedInAccount("");
      setPrinters([]);
      setPassword("");
      setCode("");
      setAwaitingCode(false);
    }
  };

  // Signed in → the auto-pulled printer list.
  if (signedInAccount) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 p-3">
          <span className="text-sm">
            Signed in as <span className="font-medium">{signedInAccount}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void signOut()}
            disabled={busy}
          >
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
        {discovering && printers.length === 0 ? (
          <div className="rounded-md border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            Loading your printers…
          </div>
        ) : null}
        {!discovering && printers.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No printers are bound to this Bambu account yet. Add the printer in the
            Bambu Handy app, then Refresh.
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

  // Awaiting the emailed verification code Bambu requires after the password.
  if (awaitingCode) {
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submitCode();
        }}
      >
        <p className="text-sm text-muted-foreground">
          Bambu emailed a 6-digit verification code to{" "}
          <span className="font-medium">{email}</span>. Enter it to finish
          signing in.
        </p>
        <Input
          autoFocus
          placeholder="Verification code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-label="Verification code"
          inputMode="numeric"
          disabled={busy}
          data-testid="printer-cloud-code"
        />
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAwaitingCode(false);
              setCode("");
              setError("");
            }}
            disabled={busy}
          >
            Back
          </Button>
          <Button
            type="submit"
            disabled={busy || !code.trim()}
            data-testid="printer-cloud-verify"
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Verify & continue
          </Button>
        </div>
      </form>
    );
  }

  // Not signed in → email + password.
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void signIn();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Sign in to Bambu Cloud with your account email and password. We’ll pull
        your printers automatically.
      </p>
      <Input
        type="email"
        autoFocus
        placeholder="Bambu account email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        aria-label="Bambu account email"
        disabled={busy}
        data-testid="printer-cloud-email"
      />
      <Input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-label="Password"
        disabled={busy}
        data-testid="printer-cloud-password"
      />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={busy || !email.trim() || !password}
          data-testid="printer-cloud-signin"
        >
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Sign in
        </Button>
      </div>
    </form>
  );
}
