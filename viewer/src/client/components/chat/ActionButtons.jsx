import { useCallback, useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/ui/utils";
import { getTransport } from "@/lib/transport";
import { selectLatestGcode, selectLatestGcode3mf, useChatStore } from "@/store/chat";
import AddPrinterDialog from "@/components/printer/AddPrinterDialog.jsx";
import PreflightModal from "./PreflightModal";
import { basename, pickPrinterForSlice } from "./actionButtonsHelpers";

export { pickPrinterForSlice };

export default function ActionButtons({
  printerList = [],
  className,
  transport = getTransport(),
}) {
  const gcodeFile = useChatStore(selectLatestGcode);
  const gcode3mfFile = useChatStore(selectLatestGcode3mf);
  const turnInProgress = useChatStore((state) => state.turnInProgress);

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
      // Cloud print prefers the sliced `.3mf` (when the toolbar slice produced
      // one); fall back to the plain gcode. LAN always uses the gcode. Upload
      // and start reference the SAME file so their names agree.
      const sendFile =
        targetPrinter.transport === "cloud" && gcode3mfFile
          ? gcode3mfFile
          : gcodeFile;
      // Upload, then start with confirmed=true (contract §2).
      await transport.printer_upload_gcode({
        printerId: targetPrinter.id,
        gcodeFile: sendFile,
      });
      await transport.printer_start_print({
        printerId: targetPrinter.id,
        remoteName: basename(sendFile),
        confirmed: true,
      });
      setPreflightOpen(false);
      setStatusMessage("Print started");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPrinting(false);
    }
  }, [gcodeFile, gcode3mfFile, targetPrinter, transport]);

  const showPrint = Boolean(gcodeFile);

  if (!showPrint) return null;

  return (
    <div
      data-slot="chat-action-buttons"
      data-has-gcode={showPrint ? "true" : "false"}
      className={cn("flex flex-col gap-2 border-t border-border/60 bg-background/60 p-2.5", className)}
    >
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
