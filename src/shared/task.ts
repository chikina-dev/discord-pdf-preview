export const LIFETIME_MS = 10 * 60_000;
export type PdfAttachment = {
  id: string;
  filename: string;
  url: string;
  sourceIndex: number;
  size: number;
};
export type PreviewTask = {
  version: 1;
  source: { messageId: string; channelId: string; guildId?: string; postedAt: number };
  attachmentId: string;
  pdfs: PdfAttachment[];
};

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function snowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}
export function attachmentUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) &&
      url.pathname.startsWith("/attachments/");
  } catch { return false; }
}
export function isTask(value: unknown): value is PreviewTask {
  if (!record(value) || value.version !== 1 || !record(value.source)) return false;
  const source = value.source;
  return snowflake(source.messageId) && snowflake(source.channelId) &&
    (source.guildId === undefined || snowflake(source.guildId)) &&
    typeof source.postedAt === "number" && Number.isFinite(source.postedAt) && source.postedAt > 0 &&
    snowflake(value.attachmentId) && Array.isArray(value.pdfs) && value.pdfs.length > 0 &&
    value.pdfs.every(pdf => record(pdf) && snowflake(pdf.id) && typeof pdf.filename === "string" &&
      attachmentUrl(pdf.url) && typeof pdf.size === "number" && pdf.size >= 0 &&
      Number.isInteger(pdf.sourceIndex) && Number(pdf.sourceIndex) >= 0) &&
    new Set(value.pdfs.map(pdf => pdf.id)).size === value.pdfs.length &&
    value.pdfs.some(pdf => pdf.id === value.attachmentId);
}
export function outputName(pdf: Pick<PdfAttachment, "id" | "filename">): string {
  const stem = pdf.filename.replace(/\.pdf$/i, "").replace(/[\x00-\x1f\x7f/\\]/g, "_");
  return `${Array.from(stem).slice(0, 80).join("") || "preview"}-${pdf.id}.png`;
}
export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}
