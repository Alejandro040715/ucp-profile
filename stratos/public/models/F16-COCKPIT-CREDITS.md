# F-16 cockpit model — credits and licence

`f16-cockpit.glb` is converted from the FlightGear F-16 (Block 50 cockpit
configuration) by `scripts/f16/convert.py` (AC3D + XML model tree -> glTF).

- Source: https://github.com/NikolaiVChr/f16 (cockpit model tree, `Models/Cockpit/`)
- Altimeter: FlightGear FGData, `Aircraft/Instruments-3d/altimeter/`
- Licence: GNU GPL version 2 or later (see `/LICENSE`)
- Original F-16 model: Erik Hofman; cockpit textures by Martin "Pegasus" Schmitt
  and Prohm "Rama" Snitwong; maintained by Nikolai V. Chr. and contributors.
  Full author list: `F16-AUTHORS.txt`, copyright notice: `F16-COPYRIGHT.txt`.

Changes made for STRATOS: geometry merged per texture with vertex colours,
textures downscaled to 1024 px, parts selected for one fixed configuration,
cockpit lifted 3.5 cm relative to the FlightGear eye point.
