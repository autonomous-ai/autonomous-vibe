// Pure math for the live build-stage "wireframe → solid" materialize. Kept
// framework-free (no THREE, no React, no clock) so it can be unit-tested in
// isolation; CadViewer's per-frame stepMaterializeAnim feeds it a 0..1 progress
// and applies the returned values to the real materials.
//
// Two phases:
//   - sketch (progress < SKIN_START): the surface is a faint ghost while the
//     edge glow ramps up — the model "draws itself in" as a wireframe.
//   - skin   (progress >= SKIN_START): the surface fills to its base opacity and
//     the edge glow decays — the wireframe "skins over" into the solid part.

export const MATERIALIZE_SKIN_START = 0.45;
export const MATERIALIZE_GHOST_OPACITY = 0.06;

export function easeInOutCubic(t) {
  const x = Math.min(Math.max(t, 0), 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Resolve the per-record visual values for a given animation progress.
 *
 * @param {number} progress 0..1 (clamped)
 * @param {number} baseOpacity the record's resting surface opacity (default 1)
 * @param {number} ghostOpacity the faint surface opacity during the sketch phase
 * @returns {{ phase: "sketch"|"skin", glow: number, surfaceOpacity: number, edgeOpacity: number }}
 *   glow: 0..1 emissive/edge glow strength (ramps up then decays)
 *   surfaceOpacity: the surface material opacity to apply
 *   edgeOpacity: the wireframe edge opacity to apply
 */
export function materializeRecordEffect(
  progress,
  baseOpacity = 1,
  ghostOpacity = MATERIALIZE_GHOST_OPACITY
) {
  const p = Math.min(Math.max(Number(progress) || 0, 0), 1);
  const inPhaseA = p < MATERIALIZE_SKIN_START;
  const phaseT = inPhaseA
    ? easeInOutCubic(p / MATERIALIZE_SKIN_START)
    : easeInOutCubic((p - MATERIALIZE_SKIN_START) / (1 - MATERIALIZE_SKIN_START));
  const glow = inPhaseA ? phaseT : 1 - phaseT;
  const surfaceOpacity = inPhaseA
    ? ghostOpacity * phaseT
    : ghostOpacity + ((baseOpacity - ghostOpacity) * phaseT);
  const edgeOpacity = inPhaseA ? phaseT : Math.max(0, 1 - phaseT);
  return { phase: inPhaseA ? "sketch" : "skin", glow, surfaceOpacity, edgeOpacity };
}
