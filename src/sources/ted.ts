/**
 * Adapter for TED Europa (api.ted.europa.eu) v3.
 *
 * Endpoint: POST https://api.ted.europa.eu/v3/notices/search
 *
 * Expert-query field names (verified live, 2026-05-18):
 *   - buyer-country = DEU         (ISO-3, NOT "DE")
 *   - place-of-performance = DE*  (NUTS prefix with wildcard)
 *   - classification-cpv = 72*    (CPV prefix with wildcard)
 *   - publication-date >= 20260401  (YYYYMMDD, NOT ISO date)
 *   - notice-type = cn-standard
 *
 * The current v3 search endpoint returns structured JSON per notice (no longer
 * a base64-eForms CONTENT blob like the older ITERATION research doc described).
 * Fields like title-proc, buyer-name come back as {deu:[...], eng:[...]} maps;
 * classification-cpv as a string[] of codes; deadline-receipt-tender-date-lot
 * as string[]. We just pick the German variant when present and fall back to
 * English / first language.
 *
 * Pagination: ITERATION mode. First response carries iterationNextToken; pass
 * it back in the body for the next page. Stop when token is null/empty or
 * results array empty.
 *
 * Allowed `limit`: 1..100 (otherwise the API rejects). We page in chunks.
 *
 * User-Agent header is mandatory.
 */
import axios from "axios";
import type {
  Notice,
  NoticeDetail,
} from "../schemas/notice.js";

const BASE = "https://api.ted.europa.eu/v3";
const SEARCH_URL = `${BASE}/notices/search`;
const USER_AGENT = "vergabe-mcp/1.1.0 (+https://github.com/xCelosx/vergabe-mcp)";

// ISO-2 -> ISO-3 for the EU/EEA countries we realistically see; default DEU
const COUNTRY_ISO2_TO_ISO3: Record<string, string> = {
  DE: "DEU",
  AT: "AUT",
  CH: "CHE",
  FR: "FRA",
  IT: "ITA",
  ES: "ESP",
  NL: "NLD",
  BE: "BEL",
  PL: "POL",
  CZ: "CZE",
  DK: "DNK",
  SE: "SWE",
  FI: "FIN",
  NO: "NOR",
  GB: "GBR",
  IE: "IRL",
  PT: "PRT",
  HU: "HUN",
  RO: "ROU",
  GR: "GRC",
  LU: "LUX",
};

export type TedSearchParams = {
  country?: string;
  publication_date_from?: string;
  publication_date_to?: string;
  cpv_prefix?: string[];
  nuts?: string[];
  max_results?: number;
};

// ---------------- query building ----------------

function toIso3(country: string | undefined): string | null {
  if (!country) return null;
  const c = country.trim().toUpperCase();
  if (c.length === 3) return c;
  return COUNTRY_ISO2_TO_ISO3[c] ?? null;
}

function toYyyymmdd(iso: string | undefined): string | null {
  if (!iso) return null;
  const cleaned = iso.replace(/-/g, "").trim();
  if (/^\d{8}$/.test(cleaned)) return cleaned;
  return null;
}

function buildExpertQuery(params: TedSearchParams): string {
  const parts: string[] = [];

  const iso3 = toIso3(params.country ?? "DE");
  if (iso3) parts.push(`buyer-country = ${iso3}`);

  if (params.cpv_prefix && params.cpv_prefix.length > 0) {
    const cpvs = params.cpv_prefix.map((p) => `classification-cpv = ${p}*`);
    parts.push(cpvs.length === 1 ? cpvs[0]! : `(${cpvs.join(" OR ")})`);
  }

  if (params.nuts && params.nuts.length > 0) {
    const ns = params.nuts.map((n) => `place-of-performance = ${n}*`);
    parts.push(ns.length === 1 ? ns[0]! : `(${ns.join(" OR ")})`);
  }

  const fromYmd = toYyyymmdd(params.publication_date_from);
  if (fromYmd) parts.push(`publication-date >= ${fromYmd}`);
  const toYmd = toYyyymmdd(params.publication_date_to);
  if (toYmd) parts.push(`publication-date <= ${toYmd}`);

  return parts.join(" AND ") || "publication-date >= 20200101";
}

// ---------------- record mapping ----------------

type TedLocalized =
  | string
  | Record<string, string | string[] | undefined>
  | undefined
  | null;

function pickLocalized(value: TedLocalized): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  // Prefer DE locales, then EN, then first non-empty
  const order = ["deu", "de", "ger", "eng", "en"];
  for (const k of order) {
    const v = value[k];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      return repairLatin1(v[0]);
    }
    if (typeof v === "string" && v.length > 0) return repairLatin1(v);
  }
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      return repairLatin1(v[0]);
    }
    if (typeof v === "string" && v.length > 0) return repairLatin1(v);
  }
  return "";
}

/**
 * The TED v3 API double-encodes some German strings: bytes that should be UTF-8
 * are presented as if they were latin-1 then re-encoded as UTF-8. This best-effort
 * recovers the intended characters. If recovery fails, returns the original.
 */
function repairLatin1(s: string): string {
  if (!s || !/[ÃÂ]/.test(s)) return s;
  try {
    const buf = Buffer.from(s, "latin1");
    const fixed = buf.toString("utf-8");
    // If the repair contains the replacement char, prefer the original.
    if (fixed.includes("�")) return s;
    return fixed;
  } catch {
    return s;
  }
}

type TedRawNotice = {
  "publication-number"?: string;
  "publication-date"?: string;
  "title-proc"?: TedLocalized;
  "description-proc"?: TedLocalized;
  "description-lot"?: TedLocalized;
  "buyer-name"?: TedLocalized;
  "buyer-country"?: string | string[];
  "classification-cpv"?: string | string[];
  "place-of-performance"?: string | string[];
  "deadline-receipt-tender-date-lot"?: string | string[];
  "deadline-receipt-request-date-lot"?: string | string[];
  "notice-type"?: string;
  "procedure-type"?: string;
  "BT-27-Lot"?: string | number | (string | number)[];
  "BT-27-LotsGroup"?: string | number | (string | number)[];
  links?: {
    html?: Record<string, string>;
    pdf?: Record<string, string>;
    xml?: Record<string, string>;
    pdfs?: Record<string, string>;
  };
};

function pickHtmlUrl(rec: TedRawNotice, id: string): string {
  const html = rec.links?.html ?? {};
  return (
    html.DEU ??
    html.ENG ??
    Object.values(html)[0] ??
    `https://ted.europa.eu/de/notice/-/detail/${encodeURIComponent(id)}`
  );
}

function firstScalar<T>(value: T | T[] | undefined | null): T | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] ?? null : null;
  return value;
}

function dedupeStringArray(arr: string[] | undefined | null): string[] {
  if (!arr) return [];
  return Array.from(new Set(arr.filter((s) => typeof s === "string" && s.length > 0)));
}

function isoDateFromTed(s: string | undefined | null): string | null {
  if (!s) return null;
  // TED uses "2026-05-04+02:00" — strip the timezone offset.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m && m[1] ? m[1] : null;
}

function parseValueNumber(v: string | number | undefined | null): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapTedNotice(rec: TedRawNotice): Notice | null {
  const id = rec["publication-number"];
  if (!id) return null;

  const title = pickLocalized(rec["title-proc"]);
  const description =
    pickLocalized(rec["description-proc"]) ||
    pickLocalized(rec["description-lot"]);

  const cpvList = Array.isArray(rec["classification-cpv"])
    ? rec["classification-cpv"]
    : rec["classification-cpv"]
      ? [rec["classification-cpv"]]
      : [];
  const cpvDeduped = dedupeStringArray(cpvList);
  const cpvMain = cpvDeduped[0] ?? null;
  const cpvExtra = cpvDeduped.slice(1);

  const places = Array.isArray(rec["place-of-performance"])
    ? rec["place-of-performance"]
    : rec["place-of-performance"]
      ? [rec["place-of-performance"]]
      : [];
  // Prefer the most specific NUTS (longest), filter out 3-letter country codes.
  const nutsCandidates = dedupeStringArray(places).filter((c) => c.length > 3);
  nutsCandidates.sort((a, b) => b.length - a.length);
  const nuts =
    nutsCandidates[0] ??
    dedupeStringArray(places).find((c) => c.startsWith("DE")) ??
    null;

  const deadlineRaw =
    firstScalar(rec["deadline-receipt-tender-date-lot"]) ??
    firstScalar(rec["deadline-receipt-request-date-lot"]);
  const deadline = isoDateFromTed(deadlineRaw);

  // BT-27-Lot is a per-lot estimated value list; take the max so a number is
  // available for sales-prioritization use cases.
  const valuesLot = rec["BT-27-Lot"];
  const valuesGrp = rec["BT-27-LotsGroup"];
  const valuesArr: (string | number)[] = [];
  if (Array.isArray(valuesLot)) valuesArr.push(...valuesLot);
  else if (valuesLot != null) valuesArr.push(valuesLot);
  if (Array.isArray(valuesGrp)) valuesArr.push(...valuesGrp);
  else if (valuesGrp != null) valuesArr.push(valuesGrp);
  const numericValues = valuesArr.map(parseValueNumber).filter((v): v is number => v != null);
  const value = numericValues.length > 0 ? Math.max(...numericValues) : null;

  return {
    id,
    source: "ted",
    title: title || "(ohne Titel)",
    description,
    cpv_main: cpvMain,
    cpv_extra: cpvExtra,
    value_eur: value,
    deadline,
    nuts,
    buyer_name: pickLocalized(rec["buyer-name"]) || "(unbekannt)",
    buyer_id: null,
    url: pickHtmlUrl(rec, id),
    published_at: isoDateFromTed(rec["publication-date"]) ?? new Date().toISOString(),
  };
}

// ---------------- public API ----------------

type TedSearchResponse = {
  totalNoticeCount?: number;
  notices?: TedRawNotice[];
  iterationNextToken?: string | null;
  message?: string;
  error?: unknown;
};

// Working field set verified against live API 2026-05-18. Anything from the
// long supported-values list can be added here; keep it tight so we don't
// blow up payload size unnecessarily.
const SEARCH_FIELDS = [
  "publication-number",
  "publication-date",
  "title-proc",
  "description-proc",
  "description-lot",
  "buyer-name",
  "buyer-country",
  "classification-cpv",
  "place-of-performance",
  "deadline-receipt-tender-date-lot",
  "deadline-receipt-request-date-lot",
  "notice-type",
  "procedure-type",
  "BT-27-Lot",
  "BT-27-LotsGroup",
  "links",
];

export async function searchTed(
  params: TedSearchParams
): Promise<{ notices: Notice[]; warnings: string[] }> {
  const warnings: string[] = [];
  const max = params.max_results ?? 500;
  const q = buildExpertQuery(params);
  // limit must be 1..100 per the API
  const pageSize = Math.min(100, Math.max(1, max));

  const collected: Notice[] = [];
  let token: string | null = null;
  const MAX_ITERATIONS = 50;

  for (let iter = 0; iter < MAX_ITERATIONS && collected.length < max; iter++) {
    const body: Record<string, unknown> = {
      query: q,
      fields: SEARCH_FIELDS,
      limit: pageSize,
      paginationMode: "ITERATION",
      onlyLatestVersions: true,
    };
    if (token) body.iterationNextToken = token;

    let res;
    try {
      res = await axios.post<TedSearchResponse>(SEARCH_URL, body, {
        timeout: 60_000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        validateStatus: () => true,
      });
    } catch (err) {
      warnings.push(`TED request error: ${(err as Error).message}`);
      break;
    }

    if (res.status === 429) {
      warnings.push("TED rate-limited (429), stopping pagination.");
      break;
    }
    if (res.status >= 400) {
      const bodyPeek = typeof res.data === "string"
        ? (res.data as string).slice(0, 300)
        : JSON.stringify(res.data).slice(0, 300);
      warnings.push(`TED search HTTP ${res.status}: ${bodyPeek}`);
      break;
    }

    const results = res.data?.notices ?? [];
    if (!results.length) break;

    for (const r of results) {
      const n = mapTedNotice(r);
      if (n) collected.push(n);
      if (collected.length >= max) break;
    }

    token = res.data?.iterationNextToken ?? null;
    if (!token) break;

    // Polite spacing between iterations
    await new Promise((r) => setTimeout(r, 500));
  }

  return { notices: collected.slice(0, max), warnings };
}

// ---------------- detail ----------------

export async function getTedDetail(noticeId: string): Promise<{
  notice: NoticeDetail | null;
  raw_xml: string | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const body = {
    query: `publication-number = "${noticeId}"`,
    fields: SEARCH_FIELDS,
    limit: 1,
    paginationMode: "ITERATION",
  };

  let res;
  try {
    res = await axios.post<TedSearchResponse>(SEARCH_URL, body, {
      timeout: 30_000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      validateStatus: () => true,
    });
  } catch (err) {
    warnings.push(`TED detail request error: ${(err as Error).message}`);
    return { notice: null, raw_xml: null, warnings };
  }

  if (res.status >= 400) {
    const bodyPeek = typeof res.data === "string"
      ? (res.data as string).slice(0, 300)
      : JSON.stringify(res.data).slice(0, 300);
    warnings.push(`TED detail HTTP ${res.status}: ${bodyPeek}`);
    return { notice: null, raw_xml: null, warnings };
  }

  const result = (res.data?.notices ?? [])[0];
  if (!result) {
    warnings.push(`TED detail: no notice with id=${noticeId}`);
    return { notice: null, raw_xml: null, warnings };
  }

  const base = mapTedNotice(result);
  if (!base) {
    warnings.push(`TED detail: failed to map result for id=${noticeId}`);
    return { notice: null, raw_xml: null, warnings };
  }

  // Attempt to fetch the XML alongside for callers who want raw eForms.
  let rawXml: string | null = null;
  const xmlUrl = result.links?.xml?.MUL ?? null;
  if (xmlUrl) {
    try {
      const xmlRes = await axios.get<string>(xmlUrl, {
        timeout: 30_000,
        headers: {
          Accept: "application/xml",
          "User-Agent": USER_AGENT,
        },
        validateStatus: () => true,
        responseType: "text",
        transformResponse: (r) => r,
      });
      if (xmlRes.status === 200 && typeof xmlRes.data === "string") {
        rawXml = xmlRes.data;
      }
    } catch {
      // optional, ignore
    }
  }

  const detail: NoticeDetail = {
    ...base,
    full_text: base.description,
    lots: [],
    attachments: [],
    eforms_xml: rawXml,
    ocds_json: null,
  };
  return { notice: detail, raw_xml: rawXml, warnings };
}
