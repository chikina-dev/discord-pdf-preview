import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { encode } from "@cf-wasm/png/node";

export async function createFixtures() {
  const text = await PDFDocument.create();
  const font = await text.embedFont(StandardFonts.Helvetica);
  const first = text.addPage([595, 842]);
  first.drawRectangle({ x: 35, y: 680, width: 525, height: 125, color: rgb(0.08, 0.35, 0.55) });
  first.drawText("PDFium / PNG preview", { x: 55, y: 750, font, size: 27, color: rgb(1, 1, 1) });
  for (let i = 0; i < 25; i++) {
    first.drawText(`Line ${i + 1}: First-page rendering on Cloudflare workerd.`, {
      x: 45, y: 640 - i * 20, font, size: 12,
    });
  }
  const second = text.addPage([595, 842]);
  second.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(1, 0, 1) });

  const vector = await PDFDocument.create();
  const vectorPage = vector.addPage([595, 842]);
  for (let i = 0; i < 10_000; i++) {
    vectorPage.drawLine({
      start: { x: (i * 37) % 595, y: (i * 71) % 842 },
      end: { x: (i * 13 + 90) % 595, y: (i * 29 + 80) % 842 },
      thickness: 0.3,
      color: rgb((i % 17) / 17, (i % 31) / 31, (i % 47) / 47),
    });
  }

  const width = 1600, height = 2200;
  const pixels = new Uint8Array(width * height * 4);
  let seed = 42;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const offset = (y * width + x) * 4;
      const noise = seed >>> 28;
      pixels[offset] = Math.min(255, Math.floor(x * 240 / width) + noise);
      pixels[offset + 1] = Math.min(255, Math.floor(y * 240 / height) + noise);
      pixels[offset + 2] = ((x >> 5) ^ (y >> 5)) % 2 ? 170 : 80;
      pixels[offset + 3] = 255;
    }
  }
  const scan = await PDFDocument.create();
  const raster = await scan.embedPng(encode(pixels, width, height));
  scan.addPage([595, 842]).drawImage(raster, { x: 0, y: 0, width: 595, height: 842 });
  return [
    { name: "text-two-pages", bytes: await text.save() },
    { name: "vector-10000-lines", bytes: await vector.save() },
    { name: "scan-1600x2200", bytes: await scan.save() },
  ];
}
