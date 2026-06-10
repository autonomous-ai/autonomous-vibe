// Free-tumble (trackball) camera rotation.
//
// three.js OrbitControls clamps the polar angle to [0, π] and keeps a fixed "up"
// axis, so its rotation can never pass over the poles — drag upward and the camera
// stops dead looking straight down the up axis. This helper replaces that rotation
// with an unconstrained trackball: it rotates the camera around `target` using
// quaternions about the camera's OWN up and right axes, and tumbles `camera.up`
// along with the offset so there is no privileged pole. The view can therefore
// rotate through any angle, including straight over the top and upside down.
//
// It mutates `camera.position` and `camera.up` in place (then re-aims at target)
// and returns true when it moved. OrbitControls keeps ownership of pan and zoom;
// its `update()` round-trips an externally-set position unchanged, so this can run
// alongside it (see useViewerRuntime).

const TWO_PI = Math.PI * 2;

/**
 * @param {object} params
 * @param {object} params.THREE     three.js module namespace
 * @param {object} params.camera    THREE.Camera (mutated)
 * @param {object} params.target    THREE.Vector3 the camera orbits around
 * @param {number} params.deltaX    pointer movement in CSS px since last sample (+ = right)
 * @param {number} params.deltaY    pointer movement in CSS px since last sample (+ = down)
 * @param {number} params.viewportHeight  element height in CSS px (drag-to-angle scale)
 * @param {number} [params.rotateSpeed=1] multiplier matching OrbitControls.rotateSpeed
 * @returns {boolean} true if the camera was moved
 */
export function applyFreeTumbleRotation({
  THREE,
  camera,
  target,
  deltaX,
  deltaY,
  viewportHeight,
  rotateSpeed = 1
}) {
  if (!THREE || !camera || !target) {
    return false;
  }
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  const speed = Number.isFinite(rotateSpeed) ? rotateSpeed : 1;
  // Mirror OrbitControls' drag-to-angle mapping (2π per element height).
  const yaw = ((TWO_PI * (Number(deltaX) || 0)) / height) * speed;
  const pitch = ((TWO_PI * (Number(deltaY) || 0)) / height) * speed;
  if (Math.abs(yaw) < 1e-7 && Math.abs(pitch) < 1e-7) {
    return false;
  }

  const offset = new THREE.Vector3().copy(camera.position).sub(target);
  if (offset.lengthSq() < 1e-12) {
    return false;
  }

  const up = new THREE.Vector3().copy(camera.up).normalize();
  const viewDir = offset.clone().normalize().negate(); // camera -> target
  let right = new THREE.Vector3().crossVectors(viewDir, up);
  if (right.lengthSq() < 1e-9) {
    // up nearly parallel to the view direction — pick any perpendicular axis.
    right = new THREE.Vector3(1, 0, 0).cross(viewDir);
    if (right.lengthSq() < 1e-9) {
      right = new THREE.Vector3(0, 1, 0).cross(viewDir);
    }
  }
  right.normalize();

  // Horizontal drag rotates about the camera's up axis; vertical drag about its
  // right axis. The negative signs match OrbitControls' drag direction (drag
  // right orbits right, drag down tilts the view downward).
  const rotation = new THREE.Quaternion().setFromAxisAngle(up, -yaw);
  rotation.multiply(new THREE.Quaternion().setFromAxisAngle(right, -pitch));

  offset.applyQuaternion(rotation);
  // Tumble up with the offset so the basis stays rigid and never hits a pole.
  camera.up.applyQuaternion(rotation).normalize();
  camera.position.copy(target).add(offset);
  camera.lookAt(target);
  return true;
}
