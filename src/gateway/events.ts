import { attachmentUrl, isTask, LIFETIME_MS, record, snowflake, type PdfAttachment, type PreviewTask } from "../shared/task.ts";

export function previewTasks(message: unknown, now: number): PreviewTask[] {
  if (!record(message) || !record(message.author) || message.author.bot || message.webhook_id ||
    !snowflake(message.id) || !snowflake(message.channel_id) || !Array.isArray(message.attachments) ||
    typeof message.timestamp !== "string") return [];
  const postedAt = Date.parse(message.timestamp);
  if (!Number.isFinite(postedAt) || postedAt + LIFETIME_MS <= now || postedAt > now + 60_000) return [];
  const pdfs: PdfAttachment[] = [];
  message.attachments.forEach((file, index) => {
    if (!record(file) || !snowflake(file.id) || typeof file.filename !== "string" ||
      !attachmentUrl(file.url) || typeof file.size !== "number") return;
    if (!/\.pdf$/i.test(file.filename) && file.content_type !== "application/pdf") return;
    pdfs.push({ id: file.id, filename: file.filename, url: file.url, size: file.size, sourceIndex: index });
  });
  const source = {
    messageId: message.id, channelId: message.channel_id, postedAt,
    ...(snowflake(message.guild_id) ? { guildId: message.guild_id } : {}),
  };
  return pdfs.map(pdf => ({ version: 1 as const, source, attachmentId: pdf.id, pdfs })).filter(isTask);
}
