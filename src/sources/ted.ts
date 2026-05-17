/**
 * Adapter for TED Europa Open Data API v3.
 *
 * Base: https://api.ted.europa.eu/v3
 * Search endpoint (anonymous): POST https://api.ted.europa.eu/v3/notices/search
 * Detail endpoint:             GET  https://api.ted.europa.eu/v3/notices/{publication-id}
 *
 * Rate limit guidance: ~60 req/min anonymous. We register 1 req/sec to be safe.
 * Docs: https://docs.ted.europa.eu/api/
 */
import { httpGet, registerRateLimit } from "../lib/http.js";
import axios from "axios";
import type { Notice, NoticeDetail, NoticeAttachment } from "../schemas/notice.js";

const BASE = "https://api.ted.europa.eu/v3";

registerRateLimit("api.ted.europa.eu", 1);

type TedSearchResponse = {
  notices?: TedNoticeRecord[];
  totalNoticeCount?: number;
  next?: string | null;
};

type TedNoticeRecord = {
  "publication-number"?: string;
  PI?: string;
  "ND-no"?: string;
  ND?: string;
  TI?: string | { eng?: string; deu?: string; [k: string]: string | undefined };
  "title-proc"?: string | Record<string, string>;
  "description-lot"?: string | Record<string, string>;
  "description-proc"?: string | Record<string, string>;
  "classification-cpv"?: string | string[];
  "main-classification-cpv"?: string;
  "additional-classification-cpv"?: string[];
  "place-of-performance"?: string | string[];
  "deadline-receipt-tender-date-lot"?: string;
  "deadline-receipt-request-date-lot"?: string;
  "buyer-name"?: string | Record<string, string>;
  "buyer-country"?: string;
  "estimated-value-cur-lot"?: string | number;
  "publication-date"?: string;
  links?: { html?: { en?: string; de?: string; [k: string]: string | undefined } };
};

function pickLocalized(
  value: string | Record<string, string | undefined> | undefined
): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return (
    value.deu ??
    value.de ??
    value.eng ??
    value.en ??
    Object.values(value).find((v): v is string => typeof v === "string") ??
    ""
  );
}

function mapTedToNotice(rec: TedNoticeRecord): Notice | null {
  const id = rec["publication-number"] ?? rec.PI ?? rec["ND-no"] ?? rec.ND;
  if (!id) return null;

  const title = pickLocalized(rec.TI ?? rec["title-proc"]);
  const description = pickLocalized(
    rec["description-proc"] ?? rec["description-lot"]
  );

  let cpvMain: string | null = null;
  let cpvExtra: string[] = [];
  if (rec["main-classification-cpv"]) cpvMain = rec["main-classification-cpv"];
  if (Array.isArray(rec["additional-classification-cpv"])) {
    cpvExtra = rec["additional-classification-cpv"];
  }
  if (!cpvMain && rec["classification-cpv"]) {
    if (typeof rec["classification-cpv"] === "string") {
      cpvMain = rec["classification-cpv"];
    } else if (Array.isArray(rec["classification-cpv"])) {
      cpvMain = rec["classification-cpv"][0] ?? null;
      cpvExtra = rec["classification-cpv"].slice(1);
    }
  }

  const nutsValue = rec["place-of-performance"];
  const nuts = Array.isArray(nutsValue) ? nutsValue[0] ?? null : (nutsValue as string ?? null);

  const value =
    typeof rec["estimated-value-cur-lot"] === "number"
      ? rec["estimated-value-cur-lot"]
      : rec["estimated-value-cur-lot"]
        ? Number(rec["estimated-value-cur-lot"])
        : null;

  const deadline =
    rec["deadline-receipt-tender-date-lot"] ??
    rec["deadline-receipt-request-date-lot"] ??
    null;

  const url =
    rec.links?.html?.de ??
    rec.links?.html?.en ??
    (rec.links?.html ? Object.values(rec.links.html)[0] : undefined) ??
    `https://ted.europa.eu/de/notice/-/detail/${encodeURIComponent(id)}`;

  return {
    id,
    source: "ted",
    title: title || "(ohne Titel)",
    description,
    cpv_main: cpvMain,
    cpv_extra: cpvExtra,
    value_eur: value && !Number.isNaN(value) ? value : null,
    deadline,
    nuts,
    buyer_name: pickLocalized(rec["buyer-name"]) || "(unbekannt)",
    buyer_id: null,
    url,
    published_at: rec["publication-date"] ?? new Date().toISOString(),
  };
}

export type TedSearchParams = {
  country?: string;
  publication_date_from?: string;
  publication_date_to?: string;
  cpv_prefix?: string[];
  nuts?: string[];
  max_results?: number;
};

/**
 * Build a TED expert-search query string from our params.
 * TED uses a structured query DSL — see https://docs.ted.europa.eu/api/.
 */
function buildTedQuery(params: TedSearchParams): string {
  const parts: string[] = [];
  if (params.country) {
    parts.push(`country = ${params.country}`);
  }
  if (params.publication_date_from || params.publication_date_to) {
    const from = (params.publication_date_from ?? "*").replace(/-/g, "");
    const to = (params.publication_date_to ?? "*").replace(/-/g, "");
    parts.push(`publication-date >= ${from} AND publication-date <= ${to}`);
  }
  if (params.cpv_prefix?.length) {
    const cpvs = params.cpv_prefix
      .map((p) => `classification-cpv = ${p}*`)
      .join(" OR ");
    parts.push(`(${cpvs})`);
  }
  if (params.nuts?.length) {
    const nuts = params.nuts.map((n) => `place-of-performance = ${n}*`).join(" OR ");
    parts.push(`(${nuts})`);
  }
  return parts.join(" AND ") || "*";
}

export async function searchTed(
  params: TedSearchParams
): Promise<{ notices: Notice[]; warnings: string[] }> {
  const warnings: string[] = [];
  const max = params.max_results ?? 500;
  const query = buildTedQuery(params);
  const url = `${BASE}/notices/search`;

  const collected: Notice[] = [];
  let page = 1;
  const pageSize = Math.min(max, 100);
  const MAX_PAGES = 10;

  while (collected.length < max && page <= MAX_PAGES) {
    try {
      // TED search uses POST with a JSON body.
      const body = {
        query,
        fields: [
          "publication-number",
          "publication-date",
          "TI",
          "title-proc",
          "description-proc",
          "description-lot",
          "classification-cpv",
          "main-classification-cpv",
          "additional-classification-cpv",
          "place-of-performance",
          "deadline-receipt-tender-date-lot",
          "deadline-receipt-request-date-lot",
          "buyer-name",
          "buyer-country",
          "estimated-value-cur-lot",
          "links",
        ],
        page,
        limit: pageSize,
        scope: "ALL",
      };

      const res = await axios.post<TedSearchResponse>(url, body, {
        timeout: 30_000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "vergabe-mcp/1.0.0",
        },
        validateStatus: () => true,
      });

      if (res.status === 429) {
        warnings.push("TED rate-limited (429). Stopping pagination.");
        break;
      }
      if (res.status >= 400) {
        warnings.push(`TED search returned HTTP ${res.status}`);
        break;
      }

      const records = res.data?.notices ?? [];
      if (records.length === 0) break;

      for (const rec of records) {
        const n = mapTedToNotice(rec);
        if (n) collected.push(n);
        if (collected.length >= max) break;
      }

      // Stop when we've drained the page or hit the total.
      if (records.length < pageSize) break;
      page++;
    } catch (err) {
      warnings.push(`TED fetch failed: ${(err as Error).message}`);
      break;
    }
  }

  return { notices: collected.slice(0, max), warnings };
}

export async function getTedDetail(
  noticeId: string
): Promise<{
  notice: NoticeDetail | null;
  raw_xml: string | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  // TED detail endpoint — JSON view.
  const url = `${BASE}/notices/${encodeURIComponent(noticeId)}`;
  try {
    const res = await httpGet<TedNoticeRecord>(url);
    if (res.status >= 400) {
      warnings.push(`TED detail returned HTTP ${res.status}`);
      return { notice: null, raw_xml: null, warnings };
    }
    const rec = res.data;
    const base = mapTedToNotice(rec);
    if (!base) {
      warnings.push("TED detail: could not map record");
      return { notice: null, raw_xml: null, warnings };
    }

    // Try to fetch raw eForms XML alongside (optional, best-effort).
    let rawXml: string | null = null;
    try {
      const xmlUrl = `${BASE}/notices/${encodeURIComponent(noticeId)}?format=xml`;
      const xmlRes = await httpGet<string>(xmlUrl, {
        headers: { Accept: "application/xml" },
        transformResponse: (r) => r,
      });
      if (xmlRes.status < 400 && typeof xmlRes.data === "string") {
        rawXml = xmlRes.data;
      }
    } catch {
      // optional, ignore
    }

    // TED attachments are not always exposed in the JSON view; use links if present.
    const attachments: NoticeAttachment[] = [];

    const detail: NoticeDetail = {
      ...base,
      full_text: base.description,
      lots: [],
      attachments,
      eforms_xml: rawXml,
      ocds_json: null,
    };
    return { notice: detail, raw_xml: rawXml, warnings };
  } catch (err) {
    warnings.push(`TED detail fetch failed: ${(err as Error).message}`);
    return { notice: null, raw_xml: null, warnings };
  }
}
