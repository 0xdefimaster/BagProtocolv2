# Inventory Fit Update

## Calibration

- FEET assets are normalized onto the 1024x1024 builder canvas and fitted to a shared shoe contact box ending at y=944.
- FEET preserve source aspect ratio and are no longer stretched to the full character width.
- NECK assets are normalized to a compact chest-safe box (x=404..620, y=385..605), preserving aspect ratio.
- Necklace pendants therefore finish around the upper chest/abdomen rather than extending into the legs.
- No CSS scaling or per-slot browser transforms are required; the PNGs remain pre-aligned assets.
