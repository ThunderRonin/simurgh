import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'assets/brand/clean/centered-logo-transparent.svg');
const pngPath = path.join(root, 'assets/brand/clean/centered-logo-transparent.png');
const svg = await readFile(svgPath, 'utf8');
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  const svgData = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const png = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 2032;
    canvas.height = 2032;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D context is unavailable.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const corners = [
      pixels.data[3],
      pixels.data[(canvas.width - 1) * 4 + 3],
      pixels.data[(canvas.height - 1) * canvas.width * 4 + 3],
      pixels.data[(canvas.width * canvas.height - 1) * 4 + 3],
    ];
    if (corners.some((alpha) => alpha !== 0)) throw new Error(`Expected transparent corners; got ${corners}.`);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG rasterization failed.')), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }, svgData);
  await writeFile(pngPath, Buffer.from(png));
} finally {
  await browser.close();
}

console.log(`Wrote ${path.relative(root, pngPath)} (2032x2032 transparent PNG).`);
