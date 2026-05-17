/**
 * Unified Notice schema used across both data sources (oeffentlichevergabe.de + TED).
 * Both sources are mapped to this canonical shape in the tool handlers.
 */
import { z } from "zod";

export type NoticeSource = "oeffentlichevergabe" | "ted";

export const NoticeSchema = z.object({
  id: z.string(),
  source: z.enum(["oeffentlichevergabe", "ted"]),
  title: z.string(),
  description: z.string(),
  cpv_main: z.string().nullable(),
  cpv_extra: z.array(z.string()),
  value_eur: z.number().nullable(),
  deadline: z.string().nullable(),
  nuts: z.string().nullable(),
  buyer_name: z.string(),
  buyer_id: z.string().nullable(),
  url: z.string(),
  published_at: z.string(),
});

export type Notice = z.infer<typeof NoticeSchema>;

export const NoticeLotSchema = z.object({
  lot_id: z.string(),
  title: z.string(),
  description: z.string(),
  cpv: z.string(),
  value_eur: z.number().nullable(),
});

export type NoticeLot = z.infer<typeof NoticeLotSchema>;

export const NoticeAttachmentSchema = z.object({
  url: z.string(),
  filename: z.string(),
  size_bytes: z.number(),
  mime_type: z.string(),
  extracted_text: z.string().nullable(),
});

export type NoticeAttachment = z.infer<typeof NoticeAttachmentSchema>;

export const NoticeDetailSchema = NoticeSchema.extend({
  full_text: z.string(),
  lots: z.array(NoticeLotSchema),
  attachments: z.array(NoticeAttachmentSchema),
  eforms_xml: z.string().nullable(),
  ocds_json: z.record(z.any()).nullable(),
});

export type NoticeDetail = z.infer<typeof NoticeDetailSchema>;

/**
 * De-dup helper: builds a fingerprint from buyer + title + deadline so notices
 * appearing in both BKMS and TED collapse to one entry.
 */
export function noticeFingerprint(n: Pick<Notice, "buyer_name" | "title" | "deadline">): string {
  const norm = (s: string | null | undefined) =>
    (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${norm(n.buyer_name)}::${norm(n.title)}::${norm(n.deadline)}`;
}
