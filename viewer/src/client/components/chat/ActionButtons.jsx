import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers, Plus, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/ui/utils";
import { getTransport } from "@/lib/transport";
import {
  selectLatestGcode,
  selectSliceTargetStl,
  useChatStore,
} from "@/store/chat";
import AddPrinterDialog from "@/components/printer/AddPrinterDialog.jsx";
import PreflightModal from "./PreflightModal";
import { basename, pickPrinterForSlice } from "./actionButtonsHelpers";

export { pickPrinterForSlice };

const DEFAULT_FILAMENT = "PLA";

export default function ActionButtons({
  printerList = [],
  defaultFilament = DEFAULT_FILAMENT,
  className,
  transport = getTransport(),
}) {
  const stlFile = useChatStore(selectSliceTargetStl);
  const gcodeFile = useChatStore(selectLatestGcode);
  const turnInProgress = useChatStore((state) => state.turnInProgress);

  const [slicing, setSlicing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [addPrinterOpen, setAddPrinterOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  // The app does not yet thread a live printer list down as a prop, so read it
  // ourselves from the backend (and re-read after a printer is added). Fall back
  // to the `printerList` prop when the transport isn't wired (browser dev mode).
  const [loadedPrinters, setLoadedPrinters] = useState(null);

  const refreshPrinters = useCallback(async () => {
    try {
      const list = await transport.printer_list();
      setLoadedPrinters(Array.isArray(list) ? list : []);
    } catch {
      // Transport unavailable — keep using the prop.
    }
  }, [transport]);

  useEffect(() => {
    void refreshPrinters();
  }, [refreshPrinters]);

  const printers = loadedPrinters ?? printerList;
  const targetPrinter = useMemo(() => pickPrinterForSlice(printers), [printers]);

  const handleSlice = useCallback(async () => {
    if (!stlFile) return;
    if (!targetPrinter) {
      // No printer yet — drop the user straight into the setup flow.
      setStatusMessage("");
      setAddPrinterOpen(true);
      return;
    }
    setSlicing(true);
    // Surface which part is being sliced — with multiple STL parts the target
    // follows the workspace selection, so make the active one explicit.
    setStatusMessage(`Slicing ${basename(stlFile)}…`);
    // eslint-disable-next-line no-console
    console.info(`[slice] target part: ${stlFile}`);
    try {
      await transport.slice_run({
        meshFile: stlFile,
        printerId: targetPrinter.id,
        filament: defaultFilament,
      });
      setStatusMessage(`Sliced ${basename(stlFile)}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSlicing(false);
    }
  }, [defaultFilament, stlFile, targetPrinter, transport]);

  const handleRequestPrint = useCallback(() => {
    if (!gcodeFile) return;
    if (!targetPrinter) {
      // No printer yet — drop the user straight into the setup flow.
      setStatusMessage("");
      setAddPrinterOpen(true);
      return;
    }
    setStatusMessage("");
    setPreflightOpen(true);
  }, [gcodeFile, targetPrinter]);

  const handleConfirmPrint = useCallback(async () => {
    if (!gcodeFile || !targetPrinter) return;
    setPrinting(true);
    try {
      // Upload, then start with confirmed=true (contract §2).
      await transport.printer_upload_gcode({
        printerId: targetPrinter.id,
        gcodeFile,
      });
      await transport.printer_start_print({
        printerId: targetPrinter.id,
        remoteName: basename(gcodeFile),
        confirmed: true,
      });
      setPreflightOpen(false);
      setStatusMessage("Print started");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPrinting(false);
    }
  }, [gcodeFile, targetPrinter, transport]);

  const showSlice = Boolean(stlFile);
  const showPrint = Boolean(gcodeFile);

  if (!showSlice && !showPrint) return null;

  return (
    <div
      data-slot="chat-action-buttons"
      data-has-stl={showSlice ? "true" : "false"}
      data-has-gcode={showPrint ? "true" : "false"}
      className={cn("flex flex-col gap-2 border-t border-border/60 bg-background/60 p-2.5", className)}
    >
      {showSlice ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSlice}
          disabled={slicing || turnInProgress}
          data-slot="chat-slice-button"
          title={`Slice ${basename(stlFile)}${targetPrinter ? ` for ${targetPrinter.model}` : ""}`}
        >
          <Layers aria-hidden />
          {slicing ? "Slicing…" : `Slice for ${targetPrinter?.model || "Bambu"}`}
        </Button>
      ) : null}
      {showSlice && !targetPrinter ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAddPrinterOpen(true)}
          data-slot="chat-add-printer-button"
          className="justify-start text-muted-foreground"
        >
          <Plus aria-hidden />
          Add a printer to slice
        </Button>
      ) : null}
      {showPrint ? (
        <Button
          variant="default"
          size="sm"
          onClick={handleRequestPrint}
          disabled={printing || turnInProgress || !targetPrinter}
          data-slot="chat-print-button"
          title={`Print ${basename(gcodeFile)}${targetPrinter ? ` on ${targetPrinter.model}` : ""}`}
        >
          <Printer aria-hidden />
          Print on {targetPrinter?.model || "printer"}
        </Button>
      ) : null}
      {statusMessage ? (
        <p data-slot="chat-action-status" className="px-1 text-[11px] text-muted-foreground">
          {statusMessage}
        </p>
      ) : null}
      <PreflightModal
        open={preflightOpen}
        onOpenChange={setPreflightOpen}
        printerLabel={targetPrinter?.model}
        gcodeFile={gcodeFile ? basename(gcodeFile) : ""}
        onConfirm={handleConfirmPrint}
        busy={printing}
      />
      <AddPrinterDialog
        open={addPrinterOpen}
        onOpenChange={setAddPrinterOpen}
        onAdded={() => {
          void refreshPrinters();
          setStatusMessage("Printer added — ready to slice.");
        }}
      />
    </div>
  );
}
