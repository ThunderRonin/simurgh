"""Create text-free SVG and viewBox-only icon derivative from the supplied SVG."""

import re
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/brand/source/recraft-recraft-v4.1-pro-vector-generated.svg"
OUTPUT = ROOT / "assets/brand/clean"
SVG_NS = "http://www.w3.org/2000/svg"
SVG = f"{{{SVG_NS}}}"
CREAM = "rgb(254,241,222)"


def main() -> None:
    root = ET.parse(SOURCE).getroot()
    removed = 0
    for parent in root.iter():
        for child in list(parent):
            match = re.search(r"\bM\s*[-+\d.eE]+[ ,]+([-+\d.eE]+)", child.get("d", ""))
            if child.tag == f"{SVG}path" and child.get("fill") == CREAM and match and float(match.group(1)) >= 1400:
                parent.remove(child)
                removed += 1
    if removed != 7:
        raise ValueError(f"Expected seven lettering paths, found {removed}")

    metadata = root.find(f"{SVG}metadata")
    if metadata is not None:
        root.remove(metadata)
    ET.register_namespace("", SVG_NS)
    ET.register_namespace("c2pa", "http://c2pa.org/manifest")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    logo = OUTPUT / "simurgh-logo.svg"
    logo.write_bytes(ET.tostring(root, encoding="utf-8", short_empty_elements=True))

    root.set("viewBox", "320 100 1400 1400")
    (OUTPUT / "simurgh-mark.svg").write_bytes(ET.tostring(root, encoding="utf-8", short_empty_elements=True))
    print(f"SVG: removed {removed} lettering paths; wrote full logo and cropped viewBox derivative")


if __name__ == "__main__":
    main()
