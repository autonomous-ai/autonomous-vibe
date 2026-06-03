import { useCallback, useEffect, useMemo, useState } from "react";
import { normalizeParameterValue } from "implicitjs/common/parameters.js";
import {
  normalizeImplicitGraphicsSettings
} from "@/workbench/implicitGraphicsSettings";

const ASSET_STATUS_LOADING = "loading";

/**
 * Encapsulates the per-selection implicit-CAD viewer state: live parameter
 * values, graphics settings, the derived render model, and the `runtime`
 * objects the implicit file-sheet sections expect. Keeping it in one hook keeps
 * the implicit wiring out of the (very large) CadWorkspace body.
 *
 * Viewer-only scope: parameter editing + graphics controls are wired; animation
 * playback and parameter copy/paste are intentionally omitted (the sheet
 * sections degrade gracefully when their handlers are absent).
 */
export function useImplicitWorkspace({ selectedImplicitModel, status = "", error = "" } = {}) {
  const definition = selectedImplicitModel?.definition || null;
  const [graphicsSettings, setGraphicsSettings] = useState(
    () => normalizeImplicitGraphicsSettings()
  );
  const [parameterValues, setParameterValues] = useState({});

  // Seed (and reset) parameter values from the model's defaults whenever a
  // different implicit model is selected.
  useEffect(() => {
    setParameterValues(definition ? { ...definition.defaultParameterValues } : {});
  }, [definition]);

  const handleParameterChange = useCallback((parameterId, value) => {
    const id = String(parameterId || "").trim();
    const parameter = definition?.parameterMap?.[id];
    if (!parameter) {
      return;
    }
    const nextValue = normalizeParameterValue(parameter, value);
    setParameterValues((current) => (
      current?.[id] === nextValue ? current : { ...current, [id]: nextValue }
    ));
  }, [definition]);

  const handleResetParameters = useCallback(() => {
    setParameterValues(definition ? { ...definition.defaultParameterValues } : {});
  }, [definition]);

  const handleGraphicsSettingsChange = useCallback((nextSettings) => {
    setGraphicsSettings(normalizeImplicitGraphicsSettings(nextSettings));
  }, []);

  // Derive the runtime model the viewer renders from the current parameter
  // values. `buildModel` re-normalizes uniforms/bounds; a throwing model
  // surfaces as an error rather than crashing the workspace.
  const runtime = useMemo(() => {
    if (!selectedImplicitModel) {
      return { model: null, error: "" };
    }
    if (!definition?.buildModel) {
      return { model: selectedImplicitModel, error: "" };
    }
    try {
      return { model: definition.buildModel(parameterValues), error: "" };
    } catch (err) {
      return { model: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [definition, parameterValues, selectedImplicitModel]);

  const parameterRuntime = useMemo(() => ({
    status: status === ASSET_STATUS_LOADING
      ? "loading"
      : runtime.error
        ? "error"
        : definition
          ? "ready"
          : "idle",
    error: runtime.error || error || "",
    definition,
    parameterValues,
    animationState: null,
    onParameterChange: handleParameterChange,
    onResetParameters: handleResetParameters
  }), [
    definition,
    error,
    handleParameterChange,
    handleResetParameters,
    parameterValues,
    runtime.error,
    status
  ]);

  const graphicsRuntime = useMemo(() => ({
    model: runtime.model,
    settings: graphicsSettings,
    onSettingsChange: handleGraphicsSettingsChange
  }), [graphicsSettings, handleGraphicsSettingsChange, runtime.model]);

  return {
    model: runtime.model,
    error: runtime.error,
    graphicsSettings,
    parameterRuntime,
    graphicsRuntime
  };
}
