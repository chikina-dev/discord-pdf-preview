import { PDFiumLibrary } from "@hyzyla/pdfium";
import pdfiumModule from "@hyzyla/pdfium/pdfium.wasm";
import { encode, initPng } from "@cf-wasm/png/workerd";

// Only the initialized renderer is reused, never document or request data.
let renderer: Promise<PDFiumLibrary> | undefined;
let pdfiumMemory: WebAssembly.Memory | undefined;
function getRenderer() {
  return renderer ??= PDFiumLibrary.init({
    instantiateWasm(imports, receiveInstance) {
      const instance = new WebAssembly.Instance(pdfiumModule, imports);
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("PDFium memory export missing");
      pdfiumMemory = memory;
      receiveInstance(instance, pdfiumModule);
    },
  });
}

const worker = {
  async fetch(request: Request) {
    if (request.method !== "POST") return new Response("POST application/pdf", { status: 405 });
    const longEdge = Number(new URL(request.url).searchParams.get("longEdge") ?? 1200);
    if (!Number.isInteger(longEdge) || longEdge < 64 || longEdge > 2400) {
      return new Response("longEdge must be 64..2400", { status: 400 });
    }
    // This endpoint is a local benchmark, not an upload API for deployment.
    const input = new Uint8Array(await request.arrayBuffer());
    if (input.byteLength > 20 * 1024 * 1024) return new Response("PDF too large", { status: 413 });
    const library = await getRenderer();
    const document = await library.loadDocument(input);
    try {
      const page = document.getPage(0);
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const image = await page.render({
        scale: longEdge / Math.max(originalWidth, originalHeight),
        render: "bitmap",
      });
      const png = encode(image.data, image.width, image.height);
      const pngModule = await initPng.ensure();
      return new Response(new Uint8Array(png).buffer, {
        headers: {
          "Content-Type": "image/png",
          "X-Image-Width": String(image.width),
          "X-Image-Height": String(image.height),
          "X-Rgba-Bytes": String(image.data.byteLength),
          "X-Pdfium-Memory-Bytes": String(pdfiumMemory?.buffer.byteLength),
          "X-Png-Memory-Bytes": String(pngModule.memory.buffer.byteLength),
        },
      });
    } finally {
      document.destroy();
    }
  },
  async queue(batch: MessageBatch<{ pdf: ArrayBuffer }>) {
    // A tiny inline PDF tests Queue event dispatch only. The actual bot should
    // enqueue attachment metadata, not PDF bytes (Queues has a 128 KB limit).
    for (const message of batch.messages) {
      const response = await worker.fetch(new Request("http://localhost/", {
        method: "POST", body: message.body.pdf,
      }));
      if (!response.ok) throw new Error(`Queue conversion failed: ${response.status}`);
      const png = await response.arrayBuffer();
      console.log(JSON.stringify({ event: "queue-preview", pngBytes: png.byteLength }));
      message.ack();
    }
  },
} satisfies ExportedHandler<unknown, { pdf: ArrayBuffer }>;

export default worker;
