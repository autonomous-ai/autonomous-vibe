import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import { KernelSize, ToneMappingMode } from "postprocessing";

// Bloom threshold: only pixels brighter than this (in linear HDR, pre-tone-map) bloom.
// The solid presets aren't emissive, so this catches the tight specular hotspots the
// key/head lights rake across metallic/clearcoat surfaces — the glossy edge glow —
// without washing the whole body. Smoothing softens the cut-in so the bloom fades in
// rather than popping on.
const LUMINANCE_THRESHOLD = 0.85;
const LUMINANCE_SMOOTHING = 0.25;
// Overall glow strength and spread. Kept restrained for a studio product look, not a
// neon halo. mipmapBlur gives a smooth, wide, cheap falloff (the modern bloom path).
const BLOOM_INTENSITY = 0.7;

/** Post-processing pass: a subtle screen-space bloom over the whole scene, so bright
 *  highlights and reflections bleed a soft glow — the studio-render finish. Mounted
 *  only when the viewer's bloom toggle is on (opt-in; it's an extra full-frame pass).
 *
 *  Enabling the composer takes over the render loop from R3F's default renderer, which
 *  means the WebGLRenderer's own tone mapping no longer runs. The ToneMapping effect
 *  (ACES_FILMIC) reproduces the Canvas's `toneMapping` setting inside the pipeline so
 *  the image matches the non-bloom path — bloom is extracted from the linear HDR scene
 *  first, then tone-mapped, which is the correct order. */
export function BloomEffects() {
  return (
    <EffectComposer>
      <Bloom
        intensity={BLOOM_INTENSITY}
        luminanceThreshold={LUMINANCE_THRESHOLD}
        luminanceSmoothing={LUMINANCE_SMOOTHING}
        mipmapBlur
        kernelSize={KernelSize.LARGE}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}
