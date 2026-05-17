/**
 * Tool: vergabe.search_notices
 *
 * Searches public procurement notices across oeffentlichevergabe.de (BKMS)
 * and TED Europa, returns a unified Notice array with de-duplication.
 */
import { z } from "zod";
import {
  searchOeffentlicheVergabe,
  type SearchParams as OvSearchParams,
} from "../sources/oeffentlichevergabe.js";
import { searchTed, type TedSearchParams } from "../sources/ted.js";
import { type Notice, noticeFingerprint } from "../schemas/notice.js";

export const SearchNoticesInputSchema = z.object({
  country: z.string().length(2).default("DE").optional(),
  publication_date_from: z.string().optional(),
  publication_date_to: z.string().optional(),
  source: z.enum(["oeffentlichevergabe", "ted", "both"]).default("both").optional(),
  cpv_prefix: z.array(z.string()).optional(),
  nuts: z.array(z.string()).optional(),
  max_results: z.number().int().positive().max(2000).default(500).optional(),
});

export type SearchNoticesInput = z.infer<typeof SearchNoticesInputSchema>;

export type SearchNoticesOutput = {
  notices: Notice[];
  total: number;
  retrieved_at: string;
  sources_used: string[];
  warnings: string[];
};

/**
 * De-dup notices coming from both sources. We prefer the BKMS (oeffentlichevergabe)
 * entry when duplicates are found because it usually carries richer German metadata
 * (CPV labels in German, full URL to the original tender platform).
 */
function dedupNotices(notices: Notice[]): { notices: Notice[]; collapsed: number } {
  const map = new Map<string, Notice>();
  let collapsed = 0;
  for (const n of notices) {
    const fp = noticeFingerprint(n);
    const existing = map.get(fp);
    if (!existing) {
      map.set(fp, n);
      continue;
    }
    collapsed++;
    // Prefer BKMS when both sources have the same notice.
    if (existing.source === "ted" && n.source === "oeffentlichevergabe") {
      map.set(fp, n);
    }
  }
  return { notices: [...map.values()], collapsed };
}

export async function runSearchNotices(
  rawInput: unknown
): Promise<SearchNoticesOutput> {
  const input = SearchNoticesInputSchema.parse(rawInput ?? {});
  const country = input.country ?? "DE";
  const source = input.source ?? "both";
  const maxResults = input.max_results ?? 500;

  const warnings: string[] = [];
  const sourcesUsed: string[] = [];
  const all: Notice[] = [];

  const ovParams: OvSearchParams = {
    country,
    publication_date_from: input.publication_date_from,
    publication_date_to: input.publication_date_to,
    cpv_prefix: input.cpv_prefix,
    nuts: input.nuts,
    max_results: maxResults,
  };

  const tedParams: TedSearchParams = {
    country,
    publication_date_from: input.publication_date_from,
    publication_date_to: input.publication_date_to,
    cpv_prefix: input.cpv_prefix,
    nuts: input.nuts,
    max_results: maxResults,
  };

  // Fetch sources in parallel when "both".
  const tasks: Promise<void>[] = [];

  if (source === "oeffentlichevergabe" || source === "both") {
    sourcesUsed.push("oeffentlichevergabe");
    tasks.push(
      (async () => {
        try {
          const { notices, warnings: w } = await searchOeffentlicheVergabe(ovParams);
          all.push(...notices);
          warnings.push(...w);
        } catch (err) {
          warnings.push(
            `oeffentlichevergabe source failed: ${(err as Error).message}`
          );
        }
      })()
    );
  }

  if (source === "ted" || source === "both") {
    sourcesUsed.push("ted");
    tasks.push(
      (async () => {
        try {
          const { notices, warnings: w } = await searchTed(tedParams);
          all.push(...notices);
          warnings.push(...w);
        } catch (err) {
          warnings.push(`TED source failed: ${(err as Error).message}`);
        }
      })()
    );
  }

  await Promise.all(tasks);

  const { notices: deduped, collapsed } = dedupNotices(all);
  if (collapsed > 0) {
    warnings.push(`De-duplicated ${collapsed} notices appearing in both sources.`);
  }

  // Cap at max_results after dedup.
  const final = deduped.slice(0, maxResults);

  return {
    notices: final,
    total: final.length,
    retrieved_at: new Date().toISOString(),
    sources_used: sourcesUsed,
    warnings,
  };
}

export const searchNoticesToolDefinition = {
  name: "vergabe_search_notices",
  description:
    "Sucht öffentliche Ausschreibungen über deutsche und EU-Datenquellen (oeffentlichevergabe.de + TED). Optional gefiltert nach Datum, Land, CPV, NUTS und Source.",
  inputSchema: {
    type: "object",
    properties: {
      country: {
        type: "string",
        description: "ISO 3166-1 alpha-2 (default: DE)",
      },
      publication_date_from: {
        type: "string",
        description: "ISO date, z.B. 2026-05-16",
      },
      publication_date_to: {
        type: "string",
        description: "ISO date",
      },
      source: {
        type: "string",
        enum: ["oeffentlichevergabe", "ted", "both"],
        description: "default: both",
      },
      cpv_prefix: {
        type: "array",
        items: { type: "string" },
        description: "optional CPV-Präfixe, z.B. ['72','48']",
      },
      nuts: {
        type: "array",
        items: { type: "string" },
        description: "optional NUTS-Codes, z.B. ['DE6','DEF']",
      },
      max_results: {
        type: "number",
        description: "default: 500",
      },
    },
    additionalProperties: false,
  },
} as const;
