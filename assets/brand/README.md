# Brand assets

`clean/simurgh-logo.svg` and `clean/simurgh-logo.png` are the supplied artwork with only the bottom `SIMURGH` lettering removed. Their phoenix, gem, colors, dimensions, and near-black background are retained.

The byte-for-byte supplied files are archived in `source/`:

- `recraft-recraft-v4.1-pro-vector-generated.svg` SHA-256: `e3fca258ef872a1c8aa94d0ee66633d6c6af6b786ddf65ed40f6861e15bcf5d6`
- `recraft-recraft-v4.1-pro-vector-generated.png` SHA-256: `c5130c36dcf9fb2370cdc745cebbcdee3d3e4819aee94ff656cab229ffe9e275`

Recreate the cleaned assets with `python3 scripts/clean-brand-svg.py` and `node scripts/clean-brand-png.mjs`. The SVG step removes seven parsed letter paths. The PNG step uses the installed Playwright Chromium canvas to clear the lettering rows with the existing `#0a0a0a` background and verifies that pixels outside those rows remain identical after PNG encoding. It also copies the generated 128px icon into the VS Code package icon path.

The C2PA metadata is omitted from the edited SVG because changing the artwork invalidates the original claim. The archived SVG retains that source metadata; no signature claim is made for the cleaned derivative.

Compact surfaces use `clean/simurgh-mark.svg` and resized PNG icon files `clean/simurgh-mark-16.png`, `-32.png`, `-48.png`, and `-128.png`. The SVG changes only the viewBox to `320 100 1400 1400`; the icons are cropped from the cleaned supplied PNG at `(318, 99)` with a `1389x1389` source region, then resized to the named dimensions. These derivatives do not redraw or recolor the artwork.
