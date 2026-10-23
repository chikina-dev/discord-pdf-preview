import { PDFiumLibrary } from "@hyzyla/pdfium";
import pdfiumModule from "@hyzyla/pdfium/pdfium.wasm";
import { encode } from "@cf-wasm/png/workerd";

let library: Promise<PDFiumLibrary> | undefined;
function renderer() {
  return library ??= PDFiumLibrary.init({
    instantiateWasm(imports, receive) {
      receive(new WebAssembly.Instance(pdfiumModule, imports), pdfiumModule);
    },
  });
}
export async function renderFirstPage(input: Uint8Array, longEdge: number): Promise<Uint8Array> {
  const document = await (await renderer()).loadDocument(input);
  try {
    const page = document.getPage(0);
    const { originalWidth, originalHeight } = page.getOriginalSize();
    if (!(originalWidth > 0 && originalHeight > 0) || !Number.isFinite(originalWidth + originalHeight)) {
      throw new Error("Invalid page dimensions");
    }
    const scale = longEdge / Math.max(originalWidth, originalHeight);
    const image = await page.render({
      width: Math.max(1, Math.floor(originalWidth * scale)),
      height: Math.max(1, Math.floor(originalHeight * scale)), scale: 1, render: "bitmap",
    });
    return encode(image.data, image.width, image.height);
  } finally { document.destroy(); }
}
