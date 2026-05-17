/**
 * Tool: vergabe.get_notice_detail
 *
 * Fetches the full notice detail (lots, attachments, raw eForms/OCDS) for a
 * single notice. Optionally downloads attachment PDFs and extracts text.
 * Results are disk-cached for 30 days.
 */
import { z } from "zod";
import {
  getOeffentlicheVergabeDetail,
} from "../sources/oeffentlichevergabe.js";
import { getTedDetail } from "../sources/ted.js";
import { httpGetBinary } from "../lib/http.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { extractPdfText } from "../lib/pdf.js";
import type {
  NoticeDetail,
  NoticeAttachment,
} from "../schemas/notice.js";

export const GetNoticeDetailInputSchema = z.object({
  notice_id: z.string().min(1),
  source: z.enum(["oeffentlichevergabe", "ted"]),
  include_pdfs: z.boolean().default(true).optional(),
});

export type GetNoticeDetailInput = z.infer<typeof GetNoticeDetailInputSchema>;

export type GetNoticeDetailOutput = {
  notice: NoticeDetail | null;
  fetched_at: string;
  warnings: string[];
  cache_hit: boolean;
};

function isPdf(att: NoticeAttachment): boolean {
  const mime = (att.mime_type ?? "").toLowerCase();
  const name = (att.filename ?? "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
}

async function enrichWithPdfs(
  attachments: NoticeAttachment[]
): Promise<{ attachments: NoticeAttachment[]; warnings: string[] }> {
  const warnings: string[] = [];
  const enriched: NoticeAttachment[] = [];

  for (const att of attachments) {
    if (!att.url) {
      enriched.push(att);
      continue;
    }
    if (!isPdf(att)) {
      enriched.push(att);
      continue;
    }
    try {
      const res = await httpGetBinary(att.url);
      if (res.status >= 400) {
        warnings.push(
          `Attachment ${att.filename}: HTTP ${res.status}, skipping extract.`
        );
        enriched.push({ ...att, size_bytes: 0 });
        continue;
      }
      const buf = res.data;
      const sizeBytes = buf.length;
      const extract = await extractPdfText(buf);
      if (extract.warning) warnings.push(`${att.filename}: ${extract.warning}`);
      enriched.push({
        ...att,
        size_bytes: sizeBytes,
        extracted_text: extract.text,
        mime_type:
          (res.headers?.["content-type"] as string | undefined) ?? att.mime_type,
      });
    } catch (err) {
      warnings.push(
        `Attachment ${att.filename}: download failed (${(err as Error).message})`
      );
      enriched.push(att);
    }
  }

  return { attachments: enriched, warnings };
}

export async function runGetNoticeDetail(
  rawInput: unknown
): Promise<GetNoticeDetailOutput> {
  const input = GetNoticeDetailInputSchema.parse(rawInput);
  const includePdfs = input.include_pdfs ?? true;
  const cacheKey = `notice-detail:${input.source}:${input.notice_id}:pdfs=${includePdfs}`;

  // Cache hit?
  const cached = await cacheGet<GetNoticeDetailOutput>(cacheKey);
  if (cached) {
    return { ...cached, cache_hit: true };
  }

  const warnings: string[] = [];
  let detail: NoticeDetail | null = null;

  if (input.source === "oeffentlichevergabe") {
    const r = await getOeffentlicheVergabeDetail(input.notice_id);
    warnings.push(...r.warnings);
    detail = r.notice;
  } else {
    const r = await getTedDetail(input.notice_id);
    warnings.push(...r.warnings);
    detail = r.notice;
  }

  if (detail && includePdfs && detail.attachments.length > 0) {
    const enriched = await enrichWithPdfs(detail.attachments);
    detail = { ...detail, attachments: enriched.attachments };
    warnings.push(...enriched.warnings);
  }

  const output: GetNoticeDetailOutput = {
    notice: detail,
    fetched_at: new Date().toISOString(),
    warnings,
    cache_hit: false,
  };

  // Only cache successful lookups.
  if (detail) {
    await cacheSet(cacheKey, output);
  }

  return output;
}

export const getNoticeDetailToolDefinition = {
  name: "vergabe_get_notice_detail",
  description:
    "Holt die kompletten Details einer Bekanntmachung inklusive Lose, Anhänge und (optional) extrahierte PDF-Texte. Resultate werden 30 Tage lokal gecached.",
  inputSchema: {
    type: "object",
    properties: {
      notice_id: {
        type: "string",
        description: "Notice-ID wie aus search_notices",
      },
      source: {
        type: "string",
        enum: ["oeffentlichevergabe", "ted"],
      },
      include_pdfs: {
        type: "boolean",
        description: "Wenn true, werden PDF-Anhänge geladen und Text extrahiert (default: true)",
      },
    },
    required: ["notice_id", "source"],
    additionalProperties: false,
  },
} as const;
