#!/usr/bin/env python3
from pathlib import Path
import xml.etree.ElementTree as ET


SVG_NS = 'http://www.w3.org/2000/svg'
SVG = f'{{{SVG_NS}}}'
BACKGROUND_PATH = 'M 0 0 L 2048 0 L 2048 2048 L 0 2048 L 0 0 z'
LETTER_REMNANT_PREFIX = 'M 1170.37 1511.24 L 1175.5 1511.14'
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/brand/source/centered-logo.svg'
OUTPUT = ROOT / 'assets/brand/clean/centered-logo-transparent.svg'


def signature(element: ET.Element, removed: set[int]) -> tuple:
    if id(element) in removed or element.tag == f'{SVG}metadata':
        return ()
    children = tuple(
        (signature(child, removed), child.tail)
        for child in element
        if id(child) not in removed and child.tag != f'{SVG}metadata'
    )
    return element.tag, tuple(sorted(element.attrib.items())), element.text, children


def main() -> None:
    ET.register_namespace('', SVG_NS)
    tree = ET.parse(SOURCE)
    root = tree.getroot()
    if root.tag != f'{SVG}svg' or root.get('viewBox') != '0 0 2048 2048':
        raise SystemExit('Unexpected centered-logo SVG root or viewBox.')

    backgrounds = [
        element for element in root.findall(f'{SVG}path')
        if element.get('fill') == 'rgb(10,10,10)' and element.get('d') == BACKGROUND_PATH
    ]
    if len(backgrounds) != 1:
        raise SystemExit(f'Expected exactly one known background path, found {len(backgrounds)}.')
    background = backgrounds[0]
    letter_remnants = [
        element for element in root.iter(f'{SVG}path')
        if element.get('fill') == 'rgb(10,10,10)' and element.get('d', '').startswith(LETTER_REMNANT_PREFIX)
    ]
    if len(letter_remnants) != 1:
        raise SystemExit(f'Expected exactly one known detached lettering remnant, found {len(letter_remnants)}.')
    letter_remnant = letter_remnants[0]
    removed = {id(background), id(letter_remnant)}
    expected = signature(root, removed)

    for parent in root.iter():
        for element in list(parent):
            if element.tag == f'{SVG}metadata' or id(element) in removed:
                parent.remove(element)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    tree.write(OUTPUT, encoding='utf-8', xml_declaration=True)
    cleaned = ET.parse(OUTPUT).getroot()
    if signature(cleaned, set()) != expected:
        raise SystemExit('The non-background SVG artwork changed during cleanup.')


if __name__ == '__main__':
    main()
