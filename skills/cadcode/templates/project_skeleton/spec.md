# CAD Spec — `<project_name>`

Human-readable design intent. The agent reads this before touching code.

## Object

<one-sentence description of what this thing is>

## Coordinate system

- XY plane is the part footprint.
- Z is vertical (up).
- Origin is at the center of the part / assembly.
- Bottom is at Z = 0; top is at Z = `height`.

## Parts

- `<name>`: <one-line role>
- `<name>`: <one-line role>

## Manufacturing

- FDM 3D printing, 0.4mm nozzle, PLA/PETG.
- Minimum wall thickness: 2.0 mm.
- Clearance for press fit: 0.2 mm.
- Clearance for slip fit: 0.4 mm.
- Avoid unsupported overhangs above 45°.

## Rules

- All numeric dimensions must live in `params.py`.
- Geometry code must not hardcode numbers.
- Each physical feature is its own function.
- Each part lives in `parts/<name>.py`.
- Each assembly lives in `assemblies/<name>.py`.
- The final shape is assigned to `result` at the end of `main.py`.
- Exports land in `exports/` (see `main.py`).
