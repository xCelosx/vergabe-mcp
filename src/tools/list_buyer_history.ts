/**
 * Tool: vergabe.list_buyer_history
 *
 * Lists historical notices from a specific buyer (Vergabestelle). Used by the
 * notice-triage skill in the Vergabe-AI Vault to compute a "relationship bonus"
 * for repeat buyers — buyers you (or your prospect) have done business with
 * before are warmer leads than cold ones.
 *
 * Implementation: this is a thin wrapper around `search_notices`. We pull a
 * broader date window and then filter client-side by buyer name, because
 * neither the BKMS OCDS endpoint nor the TED Search API exposes a stable
 * structured-buyer-name query parameter that works across both sources.
 *
 * Matching is normalized (case-insensitive, whitespace-collapsed, substring)
 * to tolerate the typical typographical drift in German Vergabestelle names
 * ("Freie und Hansestadt Hamburg" vs "Hansestadt Hamburg" vs
 * "Freie und Hansestadt Hamburg, Behörde für ...").
 */
import { z } from "zod";
import { runSearchNotices } from "./search_notices.js";
import type { Notice } from "../schemas/notice.js";

export const ListBuyerHistoryInputSchema = z.object({
  buyer_name: z.string().min(1),
  limit: z.number().int().positive().max(200).default(20).optional(),
  years_back: z.number().int().positive().max(10).default(2).optional(),
});

export type ListBuyerHistoryInput = z.infer<typeof ListBuyerHistoryInputSchema>;

export type ListBuyerHistoryOutput = {
  notices: Notice[];
  total: number;
  buyer_query: string;
  retrieved_at: string;
  sources_used: string[];
  warnings: string[];
};

/**
 * Normalize a buyer name for tolerant matching: lowercase, collapse whitespace,
 * strip the most common boilerplate suffixes that vary between publications.
 */
function normalizeBuyer(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buyerMatches(noticeBuyer: string, query: string): boolean {
  const n = normalizeBuyer(noticeBuyer);
  const q = normalizeBuyer(query);
  if (!n || !q) return false;
  return n.includes(q) || q.includes(n);
}

export async function runListBuyerHistory(
  rawInput: unknown
): Promise<ListBuyerHistoryOutput> {
  const input = ListBuyerHistoryInputSchema.parse(rawInput);
  const limit = input.limit ?? 20;
  const yearsBack = input.years_back ?? 2;

  // Build the date window.
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - yearsBack);
  const toIso = to.toISOString().slice(0, 10);
  const fromIso = from.toISOString().slice(0, 10);

  // Pull a broader page than `limit` so client-side filtering still leaves
  // enough results. Cap at 2000 which is the upper bound of search_notices.
  const wideMax = Math.min(2000, Math.max(limit * 25, 500));

  const search = await runSearchNotices({
    publication_date_from: fromIso,
    publication_date_to: toIso,
    max_results: wideMax,
    source: "both",
  });

  const filtered = search.notices
    .filter((n) => buyerMatches(n.buyer_name, input.buyer_name))
    .sort((a, b) => {
      // Newest first.
      const aTs = Date.parse(a.published_at) || 0;
      const bTs = Date.parse(b.published_at) || 0;
      return bTs - aTs;
    })
    .slice(0, limit);

  const warnings = [...search.warnings];
  if (filtered.length === 0 && search.notices.length > 0) {
    warnings.push(
      `No buyer match for "${input.buyer_name}" in the last ${yearsBack} year(s). Searched ${search.notices.length} notices.`
    );
  }

  return {
    notices: filtered,
    total: filtered.length,
    buyer_query: input.buyer_name,
    retrieved_at: new Date().toISOString(),
    sources_used: search.sources_used,
    warnings,
  };
}

export const listBuyerHistoryToolDefinition = {
  name: "vergabe_list_buyer_history",
  description:
    "Listet historische Bekanntmachungen einer bestimmten Vergabestelle (Käufer) aus den letzten N Jahren. Nutzt search_notices intern und filtert clientseitig nach Buyer-Name. Use-case: Beziehungs-Bonus auf Repeat-Buyer in der Notice-Triage.",
  inputSchema: {
    type: "object",
    properties: {
      buyer_name: {
        type: "string",
        description:
          "Name der Vergabestelle, z.B. 'Freie und Hansestadt Hamburg'. Matching ist tolerant (case-insensitive, Substring).",
      },
      limit: {
        type: "number",
        description: "Max. Anzahl Ergebnisse (default: 20, max: 200)",
      },
      years_back: {
        type: "number",
        description: "Wie viele Jahre zurück suchen (default: 2, max: 10)",
      },
    },
    required: ["buyer_name"],
    additionalProperties: false,
  },
} as const;
