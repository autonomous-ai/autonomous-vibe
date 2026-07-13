import { Billboard, Text } from "@react-three/drei";
import { useLoader } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BoxGeometry, EdgesGeometry, Vector3 } from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

// FORGE tokens can't cross into WebGL, so these literals mirror globals.css:
const WIRE_COLOR = "#9AA0AC"; // --color-muted-foreground — the bounding cage
const LABEL_COLOR = "#FF6A2B"; // --color-brand — dimension numbers

/** Formats a millimetre extent for an edge label: "42.3 mm", "8.5 mm", or "12 cm". */
function formatMm(mm: number): string {
  if (mm >= 1000) return `${(mm / 10).toFixed(0)} cm`;
  return `${mm.toFixed(mm < 10 ? 1 : 0)} mm`;
}

/**
 * Wraps the model in a bounding cage with the width × depth × height stamped on the
 * edges — so the viewer can gauge how big the part actually is. Reuses the STL already
 * cached by <StlModel> (same useLoader key = no second download). The model rests on
 * y=0 (via <Center top>), so the cage/labels are anchored to that base. Kept out of
 * <Center> so its labels never bias the model's centring; kept inside <Bounds> so the
 * framing leaves room for them. (The floor reference is the always-on <GroundGrid>;
 * this tool no longer draws its own bed grid.)
 */
export function ScaleBox({ url }: { url: string }) {
  const geometry = useLoader(STLLoader, url);

  const { size, edges } = useMemo(() => {
    geometry.computeBoundingBox();
    const cad = new Vector3();
    geometry.boundingBox?.getSize(cad);
    // <StlModel>'s parent rotates the CAD Z-up mesh -90° about X into three's
    // Y-up frame, which swaps the Y/Z extents: world = (x, z, y). So the on-bed
    // height (world Y) is the CAD Z extent.
    const worldSize = new Vector3(cad.x, cad.z, cad.y);
    const box = new BoxGeometry(worldSize.x, worldSize.y, worldSize.z);
    const wire = new EdgesGeometry(box);
    box.dispose();
    return { size: worldSize, edges: wire };
  }, [geometry]);

  useEffect(() => () => edges.dispose(), [edges]);

  const halfH = size.y / 2;
  const footprint = Math.max(size.x, size.z, 1);
  // Labels scale with the part so they stay readable at whatever distance the fit lands on.
  const labelSize = Math.max(footprint, size.y) * 0.05;
  const gap = labelSize * 0.4;

  return (
    // Model base sits on y=0, so lift the cage by halfH to span 0 → size.y and drop
    // the base-level labels onto the floor plane.
    <group>
      {/* Bounding cage — reads the model's exact extents at a glance. */}
      <lineSegments geometry={edges} position={[0, halfH, 0]}>
        <lineBasicMaterial color={WIRE_COLOR} transparent opacity={0.6} />
      </lineSegments>

      {/* Dimension labels, billboarded so they always face the camera as it orbits. */}
      <Billboard position={[0, -gap, size.z / 2]}>
        <Text fontSize={labelSize} color={LABEL_COLOR} anchorX="center" anchorY="top">
          {formatMm(size.x)}
        </Text>
      </Billboard>
      <Billboard position={[size.x / 2 + gap, -gap, 0]}>
        <Text fontSize={labelSize} color={LABEL_COLOR} anchorX="center" anchorY="top">
          {formatMm(size.z)}
        </Text>
      </Billboard>
      <Billboard position={[size.x / 2 + gap, halfH, size.z / 2]}>
        <Text fontSize={labelSize} color={LABEL_COLOR} anchorX="left" anchorY="middle">
          {formatMm(size.y)}
        </Text>
      </Billboard>
    </group>
  );
}
