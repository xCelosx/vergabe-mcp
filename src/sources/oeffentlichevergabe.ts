/**
 * Adapter for the oeffentlichevergabe.de Open Data API (BKMS).
 *
 * TODO: verify exact endpoint paths via Swagger UI at
 *   https://oeffentlichevergabe.de/documentation/swagger-ui/opendata/index.html
 * The Swagger doc is rendered client-side so canonical endpoint discovery is
 * brittle. The defaults below are robust guesses based on the public
 * BKMS Open Data conventions (OCDS-JSON). Florentin can fine-tune the
 * endpoint paths once the live Swagger response is inspected.
 *
 * Rate limit: be conservative — 1 req/sec.
 * Anonymous (no API key required).
 */
import { httpGet, registerRateLimit } from "../lib/http.js";
import type { Notice, NoticeDetail, NoticeAttachment } from "../schemas/notice.js";

const BASE = "https://oeffentlichevergabe.de/api/opendata";

// Register conservative rate limit once.
registerRateLimit("oeffentlichevergabe.de", 1);

export type SearchParams = {
  country?: string;
  publication_date_from?: string;
  publication_date_to?: string;
  cpv_prefix?: string[];
  nuts?: string[];
  max_results?: number;
};

type RawOcdsRecord = {
  ocid?: string;
  id?: string;
  tag?: string[];
  date?: string;
  buyer?: { id?: string; name?: string };
  tender?: {
    id?: string;
    title?: string;
    description?: string;
    classification?: { id?: string; description?: string; scheme?: string };
    additionalClassifications?: Array<{ id?: string; scheme?: string }>;
    value?: { amount?: number; currency?: string };
    tenderPeriod?: { endDate?: string };
    items?: Array<{
      id?: string;
      description?: string;
      classification?: { id?: string };
      additionalClassifications?: Array<{ id?: string }>;
      deliveryAddresses?: Array<{ region?: string; countryName?: string }>;
    }>;
    documents?: Array<{
      id?: string;
      title?: string;
      url?: string;
      documentType?: string;
      format?: string;
    }>;
  };
  language?: string;
};

type RawOcdsResponse = {
  releases?: RawOcdsRecord[];
  records?: Array<{ ocid?: string; compiledRelease?: RawOcdsRecord }>;
  data?: RawOcdsRecord[];
  next?: string | null;
  total?: number;
};

function mapOcdsToNotice(rec: RawOcdsRecord): Notice | null {
  const tender = rec.tender;
  if (!tender || !tender.id) return null;

  const id = rec.ocid ?? rec.id ?? tender.id;
  const cpvMain = tender.classification?.id ?? null;
  const cpvExtra = (tender.additionalClassifications ?? [])
    .map((c) => c.id)
    .filter((c): c is string => Boolean(c));
  const value = tender.value?.amount ?? null;
  const deadline = tender.tenderPeriod?.endDate ?? null;
  const nuts =
    tender.items?.[0]?.deliveryAddresses?.[0]?.region ?? null;

  const url = `https://oeffentlichevergabe.de/tenders/${encodeURIComponent(id)}`;

  return {
    id,
    source: "oeffentlichevergabe",
    title: tender.title ?? "(ohne Titel)",
    description: tender.description ?? "",
    cpv_main: cpvMain,
    cpv_extra: cpvExtra,
    value_eur: value,
    deadline,
    nuts,
    buyer_name: rec.buyer?.name ?? "(unbekannt)",
    buyer_id: rec.buyer?.id ?? null,
    url,
    published_at: rec.date ?? new Date().toISOString(),
  };
}

function flattenOcdsResponse(resp: RawOcdsResponse): RawOcdsRecord[] {
  if (resp.releases?.length) return resp.releases;
  if (resp.data?.length) return resp.data;
  if (resp.records?.length) {
    return resp.records
      .map((r) => r.compiledRelease)
      .filter((r): r is RawOcdsRecord => Boolean(r));
  }
  return [];
}

export async function searchOeffentlicheVergabe(
  params: SearchParams
): Promise<{ notices: Notice[]; warnings: string[] }> {
  const warnings: string[] = [];
  const max = params.max_results ?? 500;

  // TODO: confirm parameter names against live Swagger.
  const queryParams: Record<string, string> = {
    format: "ocds-json",
  };
  if (params.publication_date_from) {
    queryParams.publishedFrom = params.publication_date_from;
  }
  if (params.publication_date_to) {
    queryParams.publishedTo = params.publication_date_to;
  }
  if (params.country) {
    queryParams.country = params.country;
  }
  if (params.cpv_prefix?.length) {
    queryParams.cpv = params.cpv_prefix.join(",");
  }
  if (params.nuts?.length) {
    queryParams.nuts = params.nuts.join(",");
  }
  queryParams.size = String(Math.min(max, 100));

  const collected: Notice[] = [];
  let nextUrl: string | null = `${BASE}/notices`;
  let page = 0;
  const MAX_PAGES = 10;

  while (nextUrl && collected.length < max && page < MAX_PAGES) {
    const url: string =
      page === 0
        ? `${nextUrl}?${new URLSearchParams(queryParams).toString()}`
        : nextUrl;

    try {
      const res = await httpGet<RawOcdsResponse>(url);
      if (res.status >= 400) {
        warnings.push(
          `oeffentlichevergabe.de returned HTTP ${res.status} on ${url}`
        );
        break;
      }
      const records = flattenOcdsResponse(res.data ?? {});
      for (const rec of records) {
        const notice = mapOcdsToNotice(rec);
        if (notice) collected.push(notice);
        if (collected.length >= max) break;
      }
      nextUrl = res.data?.next ?? null;
      page++;
    } catch (err) {
      warnings.push(
        `oeffentlichevergabe.de fetch failed: ${(err as Error).message}`
      );
      break;
    }
  }

  return { notices: collected.slice(0, max), warnings };
}

export async function getOeffentlicheVergabeDetail(
  noticeId: string
): Promise<{
  notice: NoticeDetail | null;
  raw: RawOcdsRecord | null;
  warnings: string[];
}> {
  const warnings: string[] = [];

  // TODO: confirm exact detail endpoint path.
  const url = `${BASE}/notices/${encodeURIComponent(noticeId)}?format=ocds-json`;
  try {
    const res = await httpGet<RawOcdsRecord | RawOcdsResponse>(url);
    if (res.status >= 400) {
      warnings.push(
        `oeffentlichevergabe.de detail returned HTTP ${res.status}`
      );
      return { notice: null, raw: null, warnings };
    }

    // Endpoint may return either a single record or a wrapper.
    let raw: RawOcdsRecord | null = null;
    const data = res.data as any;
    if (data?.releases?.length) raw = data.releases[0];
    else if (data?.records?.length) raw = data.records[0].compiledRelease;
    else if (data?.tender) raw = data;

    if (!raw) {
      warnings.push("oeffentlichevergabe.de detail: unrecognized payload");
      return { notice: null, raw: null, warnings };
    }

    const base = mapOcdsToNotice(raw);
    if (!base) {
      warnings.push("oeffentlichevergabe.de detail: could not map record");
      return { notice: null, raw, warnings };
    }

    const lots =
      raw.tender?.items?.map((it, idx) => ({
        lot_id: it.id ?? `lot-${idx}`,
        title: it.description ?? "",
        description: it.description ?? "",
        cpv: it.classification?.id ?? "",
        value_eur: null,
      })) ?? [];

    const attachments: NoticeAttachment[] =
      raw.tender?.documents?.map((d) => ({
        url: d.url ?? "",
        filename: d.title ?? d.id ?? "document",
        size_bytes: 0,
        mime_type: d.format ?? "application/octet-stream",
        extracted_text: null,
      })) ?? [];

    const detail: NoticeDetail = {
      ...base,
      full_text: raw.tender?.description ?? base.description,
      lots,
      attachments,
      eforms_xml: null,
      ocds_json: raw as unknown as Record<string, any>,
    };
    return { notice: detail, raw, warnings };
  } catch (err) {
    warnings.push(
      `oeffentlichevergabe.de detail fetch failed: ${(err as Error).message}`
    );
    return { notice: null, raw: null, warnings };
  }
}
