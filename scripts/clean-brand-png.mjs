import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets/brand/source/recraft-recraft-v4.1-pro-vector-generated.png');
const output = path.join(root, 'assets/brand/clean');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const sourceUrl = `data:image/png;base64,${(await readFile(source)).toString('base64')}`;
  const result = await page.evaluate(async (pngUrl) => {
    const load = async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    };
    const original = await load(pngUrl);
    if (original.width !== 2032 || original.height !== 2032) throw new Error('Unexpected supplied PNG dimensions');
    const makeCanvas = (width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    };
    const full = makeCanvas(original.width, original.height);
    const context = full.getContext('2d', { willReadFrequently: true });
    context.drawImage(original, 0, 0);
    const input = context.getImageData(0, 0, original.width, original.height);
    const pixels = new Uint8ClampedArray(input.data);
    let minY = original.height;
    let maxY = -1;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 254 && pixels[i + 1] === 241 && pixels[i + 2] === 222) {
        const y = Math.floor(i / 4 / original.width);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxY < minY || minY < 1400 || maxY > 1700) throw new Error(`Unexpected wordmark rows ${minY}..${maxY}`);
    const top = minY - 2;
    const bottom = maxY + 3;
    for (let y = top; y < bottom; y++) {
      for (let x = 0; x < original.width; x++) {
        const i = (y * original.width + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 10;
      }
    }
    context.putImageData(new ImageData(pixels, original.width, original.height), 0, 0);
    const fullUrl = full.toDataURL('image/png');

    const outputImage = await load(fullUrl);
    const check = makeCanvas(original.width, original.height).getContext('2d', { willReadFrequently: true });
    check.drawImage(outputImage, 0, 0);
    const outputPixels = check.getImageData(0, 0, original.width, original.height).data;
    for (let y = 0; y < original.height; y++) {
      for (let x = 0; x < original.width; x++) {
        const i = (y * original.width + x) * 4;
        if (top <= y && y < bottom) {
          if (outputPixels[i] !== 10 || outputPixels[i + 1] !== 10 || outputPixels[i + 2] !== 10) throw new Error('Wordmark pixels remain');
        } else if (outputPixels[i] !== input.data[i] || outputPixels[i + 1] !== input.data[i + 1] || outputPixels[i + 2] !== input.data[i + 2]) {
          throw new Error(`PNG pixels changed outside the wordmark at ${x},${y}`);
        }
      }
    }

    const iconSide = 1389;
    const cropX = 318;
    const cropY = 99;
    const icons = [];
    for (const size of [16, 32, 48, 128]) {
      const canvas = makeCanvas(size, size);
      canvas.getContext('2d').drawImage(outputImage, cropX, cropY, iconSide, iconSide, 0, 0, size, size);
      icons.push({ size, dataUrl: canvas.toDataURL('image/png') });
    }
    return { fullUrl, icons, rows: [top, bottom], crop: [cropX, cropY, iconSide] };
  }, sourceUrl);

  const writeDataUrl = async (filename, dataUrl) => {
    await writeFile(path.join(output, filename), Buffer.from(dataUrl.split(',')[1], 'base64'));
  };
  await writeDataUrl('simurgh-logo.png', result.fullUrl);
  for (const icon of result.icons) await writeDataUrl(`simurgh-mark-${icon.size}.png`, icon.dataUrl);
  await copyFile(path.join(output, 'simurgh-mark-128.png'), path.join(root, 'packages/vscode-extension/simurgh-logo.png'));
  console.log(`PNG: cleared lettering rows ${result.rows[0]}..${result.rows[1] - 1}; outside pixels verified unchanged`);
  console.log(`PNG icon crops: ${result.crop[2]}px square at (${result.crop[0]}, ${result.crop[1]}), resized to 16/32/48/128px`);
} finally {
  await browser.close();
}
