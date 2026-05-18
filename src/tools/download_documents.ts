/**
 * Tool: vergabe.download_documents  (v1.0 STUB)
 *
 * Locks the public API surface for v1.0 so it can be shipped to npm without
 * breaking-change risk later. The full implementation will land in v2.0
 * alongside Playbook 02 of the Vergabe-AI Vault, which will download all
 * Vergabe-Unterlagen (Leistungsverzeichnis, EVB-IT, Anlagen, etc.) into a
 * target directory for offline analysis.
 *
 * For now, callers should use `get_notice_detail` to obtain the document URLs
 * from the `attachments` array and download them manually.
 */
import { z } from "zod";

export const DownloadDocumentsInputSchema = z.object({
  notice_id: z.string().min(1),
  target_dir: z.string().min(1),
  source: z.enum(["oeffentlichevergabe", "ted"]).default("oeffentlichevergabe").optional(),
});

export type DownloadDocumentsInput = z.infer<
  typeof DownloadDocumentsInputSchema
>;

export type DownloadDocumentsOutput = {
  status: "not_yet_implemented" | "ok" | "error";
  message: string;
  files?: string[];
};

export async function runDownloadDocuments(
  rawInput: unknown
): Promise<DownloadDocumentsOutput> {
  // Validate input so the API contract is enforced even in the stub — callers
  // get a clear schema error rather than silent acceptance of garbage.
  DownloadDocumentsInputSchema.parse(rawInput);

  return {
    status: "not_yet_implemented",
    message:
      "Document download is part of Playbook 02 (vergabe-mcp v2.0). For now, fetch the document URLs via get_notice_detail and download manually.",
  };
}

export const downloadDocumentsToolDefinition = {
  name: "vergabe_download_documents",
  description:
    "(STUB — v2.0) Lädt alle Vergabeunterlagen einer Bekanntmachung in ein Zielverzeichnis. Aktuell nicht implementiert: nutze get_notice_detail und lade die URLs aus dem attachments-Array manuell.",
  inputSchema: {
    type: "object",
    properties: {
      notice_id: {
        type: "string",
        description: "Notice-ID wie aus search_notices / get_notice_detail",
      },
      target_dir: {
        type: "string",
        description: "Absoluter Pfad zum Zielverzeichnis",
      },
      source: {
        type: "string",
        enum: ["oeffentlichevergabe", "ted"],
        description: "default: oeffentlichevergabe",
      },
    },
    required: ["notice_id", "target_dir"],
    additionalProperties: false,
  },
} as const;
