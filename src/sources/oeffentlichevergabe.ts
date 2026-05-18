/**
 * Adapter for oeffentlichevergabe.de (BKMS / Datenservice Oeffentlicher Einkauf).
 *
 * NOTE: There is no JSON search endpoint with query filters. The public
 * Open Data interface is a per-day CSV-ZIP bulk export:
 *   GET /api/notice-exports?pubDay=YYYY-MM-DD&format=csv.zip
 *
 * The ZIP contains ~10 normalized CSV tables (notice, purpose, organisation,
 * classification, placeOfPerformance, lot, procedure, duration,
 * submissionTerms, ...). We download per day, parse, join, and filter
 * client-side. Notice details are available via:
 *   GET /api/notices/{notice_id}  (Accept: application/xml -> eForms XML)
 *
 * Reference impl (Python): D:/trading_bot/gemeinsambieten/backend/app/services/doe_client.py
 *
 * Yesterday is the latest available day — today returns no data.
 */
import axios from "axios";
import JSZip from "jszip";
import Papa from "papaparse";
import { parseStringPromise } from "xml2js";
import type {
  Notice,
  NoticeDetail,
  NoticeAttachment,
  NoticeLot,
} from "../schemas/notice.js";

const BASE = "https://oeffentlichevergabe.de";
const EXPORT_URL = `${BASE}/api/notice-exports`;
const USER_AGENT = "vergabe-mcp/1.1.0 (+https://github.com/xCelosx/vergabe-mcp)";

// Limit to contract notices (offers companies can bid on). Excludes
// award notices, modifications, voluntary ex-ante, etc.
const COMPETITION_NOTICE_TYPES = new Set([
  "cn-standard",
  "cn-social",
  "cn-desg",
]);

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2_000;

export type SearchParams = {
  country?: string;
  publication_date_from?: string;
  publication_date_to?: string;
  cpv_prefix?: string[];
  nuts?: string[];
  max_results?: number;
};

// ---------------- low-level helpers ----------------

function isoDate(d: Date): string {
  // YYYY-MM-DD in UTC
  return d.toISOString().slice(0, 10);
}

function parseIsoDate(s: string): Date | null {
  // tolerant: accept "2026-05-17" and "2026-05-17T00:00:00Z"
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return isNaN(d.getTime()) ? null : d;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Download the CSV ZIP for one day, with retry. Returns null if not available. */
async function downloadDayZip(pubDay: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await axios.get(EXPORT_URL, {
        params: { pubDay, format: "csv.zip" },
        responseType: "arraybuffer",
        headers: { "User-Agent": USER_AGENT },
        timeout: 120_000,
        validateStatus: () => true,
        maxRedirects: 5,
      });
      if (res.status === 200) {
        return Buffer.from(res.data);
      }
      if (res.status === 404 || res.status === 204) {
        // No data for this day — graceful skip (e.g. weekend, holiday)
        return null;
      }
      // Retry on 5xx / 429
      if (res.status >= 500 || res.status === 429) {
        if (attempt === MAX_RETRIES - 1) return null;
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      // Other 4xx: bail
      return null;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) return null;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
    }
  }
  return null;
}

type CsvRow = Record<string, string>;

/** Unzip and parse every .csv file into an in-memory table. */
async function parseZipToTables(
  buf: Buffer
): Promise<Record<string, CsvRow[]>> {
  const zip = await JSZip.loadAsync(buf);
  const tables: Record<string, CsvRow[]> = {};
  for (const filename of Object.keys(zip.files)) {
    if (!filename.endsWith(".csv")) continue;
    const file = zip.files[filename];
    if (!file || file.dir) continue;
    const text = await file.async("text");
    const tableName = filename.replace(/\.csv$/, "").split("/").pop() || filename;
    const parsed = Papa.parse<CsvRow>(text, {
      header: true,
      skipEmptyLines: true,
    });
    tables[tableName] = (parsed.data || []).filter((r) => r && typeof r === "object");
  }
  return tables;
}

// ---------------- join + map ----------------

type DoeLot = {
  lot_id: string;
  title: string;
  description: string | null;
  cpv_main: string | null;
  estimated_value: number | null;
  nuts_code: string | null;
  nuts_city: string | null;
  deadline_date: string | null;
  duration_start: string | null;
  duration_end: string | null;
};

type DoeNotice = {
  notice_id: string;
  notice_version: string;
  publication_date: string;
  form_type: string;
  notice_type: string;
  title: string;
  description: string | null;
  contracting_authority: string | null;
  contracting_authority_city: string | null;
  contracting_authority_nuts: string | null;
  contract_type: string | null;
  procedure_type: string | null;
  estimated_value: number | null;
  estimated_value_currency: string | null;
  cpv_main: string | null;
  cpv_additional: string[];
  nuts_code: string | null;
  nuts_city: string | null;
  reference_number: string | null;
  deadline_date: string | null;
  buyer_profile_url: string | null;
  buyer_website: string | null;
  lots: DoeLot[];
};

function nKey(row: CsvRow): string {
  return `${row.noticeIdentifier ?? ""}|${row.noticeVersion ?? ""}`;
}
function lKey(row: CsvRow): string {
  return `${row.noticeIdentifier ?? ""}|${row.noticeVersion ?? ""}|${row.lotIdentifier ?? ""}`;
}

function parseNumber(s: string | undefined | null): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Pure join + filter, ported from doe_client.py:_build_notices */
function buildNoticesFromTables(
  tables: Record<string, CsvRow[]>,
  opts: { competitionOnly: boolean; maxNotices?: number }
): DoeNotice[] {
  const notices = tables["notice"] ?? [];
  const purpose = tables["purpose"] ?? [];
  const orgs = tables["organisation"] ?? [];
  const classif = tables["classification"] ?? [];
  const places = tables["placeOfPerformance"] ?? [];
  const lots = tables["lot"] ?? [];
  const procedures = tables["procedure"] ?? [];
  const durations = tables["duration"] ?? [];
  const submissions = tables["submissionTerms"] ?? [];

  const purposeByNotice = new Map<string, CsvRow[]>();
  for (const r of purpose) {
    const k = nKey(r);
    let arr = purposeByNotice.get(k);
    if (!arr) {
      arr = [];
      purposeByNotice.set(k, arr);
    }
    arr.push(r);
  }

  const orgByNotice = new Map<string, CsvRow[]>();
  for (const r of orgs) {
    const k = nKey(r);
    let arr = orgByNotice.get(k);
    if (!arr) {
      arr = [];
      orgByNotice.set(k, arr);
    }
    arr.push(r);
  }

  const classByNotice = new Map<string, CsvRow[]>();
  const classByLot = new Map<string, CsvRow[]>();
  for (const r of classif) {
    if (r.lotIdentifier) {
      const k = lKey(r);
      let arr = classByLot.get(k);
      if (!arr) {
        arr = [];
        classByLot.set(k, arr);
      }
      arr.push(r);
    } else {
      const k = nKey(r);
      let arr = classByNotice.get(k);
      if (!arr) {
        arr = [];
        classByNotice.set(k, arr);
      }
      arr.push(r);
    }
  }

  const placeByNotice = new Map<string, CsvRow[]>();
  const placeByLot = new Map<string, CsvRow[]>();
  for (const r of places) {
    if (r.lotIdentifier) {
      const k = lKey(r);
      let arr = placeByLot.get(k);
      if (!arr) {
        arr = [];
        placeByLot.set(k, arr);
      }
      arr.push(r);
    } else {
      const k = nKey(r);
      let arr = placeByNotice.get(k);
      if (!arr) {
        arr = [];
        placeByNotice.set(k, arr);
      }
      arr.push(r);
    }
  }

  const lotsByNotice = new Map<string, CsvRow[]>();
  for (const r of lots) {
    const k = nKey(r);
    let arr = lotsByNotice.get(k);
    if (!arr) {
      arr = [];
      lotsByNotice.set(k, arr);
    }
    arr.push(r);
  }

  const procByNotice = new Map<string, CsvRow>();
  for (const r of procedures) procByNotice.set(nKey(r), r);

  const durByLot = new Map<string, CsvRow>();
  for (const r of durations) durByLot.set(lKey(r), r);

  const subByLot = new Map<string, CsvRow>();
  for (const r of submissions) subByLot.set(lKey(r), r);

  const result: DoeNotice[] = [];

  for (const nrow of notices) {
    const noticeType = nrow.noticeType ?? "";
    if (opts.competitionOnly && !COMPETITION_NOTICE_TYPES.has(noticeType)) {
      continue;
    }

    const nk = nKey(nrow);
    const noticeId = nrow.noticeIdentifier ?? "";

    // Notice-level purpose (row without lotIdentifier; fallback to first)
    const purposes = purposeByNotice.get(nk) ?? [];
    let noticePurpose: CsvRow | null = null;
    for (const p of purposes) {
      if (!p.lotIdentifier) {
        noticePurpose = p;
        break;
      }
    }
    if (!noticePurpose && purposes.length > 0) noticePurpose = purposes[0] ?? null;

    // Buyer = first organisation with role "buyer"
    let buyer: CsvRow | null = null;
    for (const o of orgByNotice.get(nk) ?? []) {
      if (o.organisationRole === "buyer") {
        buyer = o;
        break;
      }
    }

    // Notice-level classification (main CPV + additionals)
    let cpvMain: string | null = null;
    const cpvAdditional: string[] = [];
    for (const cls of classByNotice.get(nk) ?? []) {
      const main = cls.mainClassificationCode ?? "";
      if (main && !cpvMain) cpvMain = main;
      const addl = cls.additionalClassificationCodes ?? "";
      if (addl) {
        for (const c of addl.split(",")) {
          const t = c.trim();
          if (t) cpvAdditional.push(t);
        }
      }
    }

    // Notice-level place
    let place: CsvRow | null = null;
    for (const p of placeByNotice.get(nk) ?? []) {
      if (!p.lotIdentifier) {
        place = p;
        break;
      }
    }

    const proc = procByNotice.get(nk) ?? null;

    const notice: DoeNotice = {
      notice_id: noticeId,
      notice_version: nrow.noticeVersion ?? "01",
      publication_date: nrow.publicationDate ?? "",
      form_type: nrow.formType ?? "",
      notice_type: noticeType,
      title: (noticePurpose?.title ?? "") || `Bekanntmachung ${noticeId.slice(0, 8)}`,
      description: noticePurpose?.description ?? null,
      contracting_authority: buyer?.organisationName ?? null,
      contracting_authority_city: buyer?.organisationCity ?? null,
      contracting_authority_nuts: buyer?.organisationCountrySubdivision ?? null,
      contract_type: noticePurpose?.mainNature ?? null,
      procedure_type: proc?.procedureType ?? null,
      estimated_value: parseNumber(noticePurpose?.estimatedValue),
      estimated_value_currency: noticePurpose?.estimatedValueCurrency ?? null,
      cpv_main: cpvMain,
      cpv_additional: cpvAdditional,
      nuts_code: place?.placePerformanceCountrySubdivision ?? null,
      nuts_city: place?.placePerformanceCity ?? null,
      reference_number: noticePurpose?.internalIdentifier ?? null,
      deadline_date: null,
      buyer_profile_url:
        (buyer?.buyerProfileURL ?? "").trim() ? (buyer!.buyerProfileURL ?? null) : null,
      buyer_website:
        (buyer?.organisationInternetAddress ?? "").trim()
          ? (buyer!.organisationInternetAddress ?? null)
          : null,
      lots: [],
    };

    // Lots
    for (const lotRaw of lotsByNotice.get(nk) ?? []) {
      const lotId = lotRaw.lotIdentifier ?? "";
      const lk = `${noticeId}|${nrow.noticeVersion ?? ""}|${lotId}`;

      let lotPurpose: CsvRow | null = null;
      for (const p of purposes) {
        if (p.lotIdentifier === lotId) {
          lotPurpose = p;
          break;
        }
      }

      let lotCpv: string | null = null;
      for (const cls of classByLot.get(lk) ?? []) {
        const main = cls.mainClassificationCode ?? "";
        if (main) {
          lotCpv = main;
          break;
        }
      }
      if (!lotCpv) lotCpv = cpvMain;

      const lotPlaces = placeByLot.get(lk) ?? [];
      const lotPlace = lotPlaces.length > 0 ? lotPlaces[0] ?? null : null;

      const dur = durByLot.get(lk) ?? null;
      const sub = subByLot.get(lk) ?? null;
      const lotDeadline = sub?.publicOpeningDate ?? null;

      const lot: DoeLot = {
        lot_id: lotId,
        title: lotPurpose?.title ?? `Los ${lotId}`,
        description: lotPurpose?.description ?? null,
        cpv_main: lotCpv,
        estimated_value: parseNumber(lotPurpose?.estimatedValue),
        nuts_code: lotPlace?.placePerformanceCountrySubdivision ?? null,
        nuts_city: lotPlace?.placePerformanceCity ?? null,
        deadline_date: lotDeadline,
        duration_start: dur?.durationStartDate ?? null,
        duration_end: dur?.durationEndDate ?? null,
      };
      notice.lots.push(lot);
    }

    // Promote first lot deadline to notice level if available
    for (const lot of notice.lots) {
      if (lot.deadline_date) {
        notice.deadline_date = lot.deadline_date;
        break;
      }
    }

    result.push(notice);
    if (opts.maxNotices && result.length >= opts.maxNotices) break;
  }

  return result;
}

// ---------------- mapping to unified Notice schema ----------------

function mapToNotice(d: DoeNotice): Notice {
  const url = `${BASE}/tenders/${encodeURIComponent(d.notice_id)}`;
  return {
    id: d.notice_id,
    source: "oeffentlichevergabe",
    title: d.title || "(ohne Titel)",
    description: d.description ?? "",
    cpv_main: d.cpv_main,
    cpv_extra: d.cpv_additional,
    value_eur: d.estimated_value,
    deadline: d.deadline_date,
    nuts: d.nuts_code,
    buyer_name: d.contracting_authority ?? "(unbekannt)",
    buyer_id: null,
    url,
    published_at: d.publication_date || new Date().toISOString(),
  };
}

// ---------------- public API ----------------

/** List of YYYY-MM-DD strings between two ISO dates (inclusive, clipped to yesterday). */
function daysBetween(fromIso: string | undefined, toIso: string | undefined): string[] {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(0, 0, 0, 0);

  let from: Date;
  let to: Date;

  if (fromIso) {
    const p = parseIsoDate(fromIso);
    from = p ?? new Date(yesterday);
  } else {
    from = new Date(yesterday);
  }
  if (toIso) {
    const p = parseIsoDate(toIso);
    to = p ?? new Date(yesterday);
  } else {
    to = new Date(yesterday);
  }

  // Clip end at yesterday (today never has data)
  if (to.getTime() > yesterday.getTime()) {
    to = new Date(yesterday);
  }
  if (from.getTime() > to.getTime()) {
    return [];
  }

  const days: string[] = [];
  const cursor = new Date(from);
  // hard cap to avoid runaway queries
  let safety = 0;
  while (cursor.getTime() <= to.getTime() && safety < 60) {
    days.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    safety++;
  }
  return days;
}

function notice_matches_filters(
  n: DoeNotice,
  params: SearchParams
): boolean {
  // country: BKMS export is national; we treat as DE by definition.
  // If a different country is requested, skip.
  if (params.country && params.country.toUpperCase() !== "DE") return false;

  if (params.cpv_prefix && params.cpv_prefix.length > 0) {
    const cpvs: string[] = [];
    if (n.cpv_main) cpvs.push(n.cpv_main);
    cpvs.push(...n.cpv_additional);
    for (const lot of n.lots) if (lot.cpv_main) cpvs.push(lot.cpv_main);
    const hit = params.cpv_prefix.some((prefix) =>
      cpvs.some((c) => c.startsWith(prefix))
    );
    if (!hit) return false;
  }

  if (params.nuts && params.nuts.length > 0) {
    const nutsList: string[] = [];
    if (n.nuts_code) nutsList.push(n.nuts_code);
    if (n.contracting_authority_nuts) nutsList.push(n.contracting_authority_nuts);
    for (const lot of n.lots) if (lot.nuts_code) nutsList.push(lot.nuts_code);
    const hit = params.nuts.some((prefix) =>
      nutsList.some((nc) => nc.startsWith(prefix))
    );
    if (!hit) return false;
  }

  return true;
}

export async function searchOeffentlicheVergabe(
  params: SearchParams
): Promise<{ notices: Notice[]; warnings: string[] }> {
  const warnings: string[] = [];
  const max = params.max_results ?? 500;
  const days = daysBetween(params.publication_date_from, params.publication_date_to);

  if (days.length === 0) {
    warnings.push(
      "oeffentlichevergabe: no eligible days in window (today is never available, only yesterday and earlier)."
    );
    return { notices: [], warnings };
  }

  const collected: Notice[] = [];

  for (let i = 0; i < days.length && collected.length < max; i++) {
    const day = days[i]!;
    const zipBuf = await downloadDayZip(day);
    if (!zipBuf) {
      warnings.push(`oeffentlichevergabe: no data for ${day} (skipped).`);
      if (i < days.length - 1) await sleep(1_000);
      continue;
    }

    let tables: Record<string, CsvRow[]>;
    try {
      tables = await parseZipToTables(zipBuf);
    } catch (err) {
      warnings.push(
        `oeffentlichevergabe: failed to parse ZIP for ${day}: ${(err as Error).message}`
      );
      continue;
    }

    const remaining = max - collected.length;
    const built = buildNoticesFromTables(tables, {
      competitionOnly: true,
      maxNotices: undefined, // filter first, then cap
    });

    for (const d of built) {
      if (!notice_matches_filters(d, params)) continue;
      collected.push(mapToNotice(d));
      if (collected.length >= max) break;
    }

    if (i < days.length - 1 && collected.length < max) {
      await sleep(1_000);
    }
    void remaining;
  }

  return { notices: collected.slice(0, max), warnings };
}

// ---------------- detail ----------------

/** Fetch the raw eForms XML for a notice id. */
async function fetchNoticeXml(noticeId: string): Promise<string | null> {
  const url = `${BASE}/api/notices/${encodeURIComponent(noticeId)}`;
  try {
    const res = await axios.get<string>(url, {
      headers: {
        Accept: "application/xml",
        "User-Agent": USER_AGENT,
      },
      timeout: 30_000,
      validateStatus: () => true,
      maxRedirects: 5,
      responseType: "text",
      transformResponse: (r) => r,
    });
    if (res.status !== 200) return null;
    return typeof res.data === "string" ? res.data : String(res.data);
  } catch {
    return null;
  }
}

/** Extract first SubmissionDeadline/EndDate from raw eForms XML via regex. */
function extractDeadlineFromXml(xml: string): string | null {
  const m = xml.match(/SubmissionDeadline[\s\S]*?<cbc:EndDate[^>]*>(\d{4}-\d{2}-\d{2})/);
  return m && m[1] ? m[1] : null;
}

/** Minimal best-effort extraction from XML for fields not in any CSV day. */
async function parseXmlMeta(xml: string): Promise<{
  title: string | null;
  description: string | null;
  buyer: string | null;
  cpv_main: string | null;
  estimated_value: number | null;
  deadline: string | null;
  attachments: NoticeAttachment[];
}> {
  let parsed: any = null;
  try {
    parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [(name: string) => name.replace(/^.+:/, "")],
    });
  } catch {
    return {
      title: null,
      description: null,
      buyer: null,
      cpv_main: null,
      estimated_value: null,
      deadline: extractDeadlineFromXml(xml),
      attachments: [],
    };
  }

  // Walk the parsed tree and find values by tag-name suffix.
  function findFirstText(node: any, name: string): string | null {
    if (node == null) return null;
    if (typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const c of node) {
        const r = findFirstText(c, name);
        if (r) return r;
      }
      return null;
    }
    for (const key of Object.keys(node)) {
      if (key === name) {
        const val = node[key];
        if (typeof val === "string") return val;
        if (val && typeof val === "object" && "_" in val) return String(val._);
        if (val && typeof val === "object") {
          const inner = findFirstText(val, name);
          if (inner) return inner;
        }
      }
      const child = node[key];
      const r = findFirstText(child, name);
      if (r) return r;
    }
    return null;
  }

  function findAllText(node: any, name: string, out: string[] = []): string[] {
    if (node == null || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const c of node) findAllText(c, name, out);
      return out;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (key === name) {
        if (typeof child === "string") out.push(child);
        else if (child && typeof child === "object" && typeof child._ === "string") out.push(child._);
      }
      findAllText(child, name, out);
    }
    return out;
  }

  const title = findFirstText(parsed, "Name");
  const description = findFirstText(parsed, "Description");
  const buyer = findFirstText(parsed, "PartyName");
  const cpvMain = findFirstText(parsed, "ItemClassificationCode");
  const valueStr = findFirstText(parsed, "EstimatedOverallContractAmount");
  const valueNum = parseNumber(valueStr ?? undefined);
  const deadline =
    findFirstText(parsed, "EndDate") ?? extractDeadlineFromXml(xml);

  // Attachments: look for CallForTendersDocumentReference -> URI
  const uris = findAllText(parsed, "URI").filter((u) =>
    typeof u === "string" && u.startsWith("http")
  );
  const attachments: NoticeAttachment[] = uris.slice(0, 50).map((url, i) => ({
    url,
    filename: `document-${i + 1}`,
    size_bytes: 0,
    mime_type: "application/octet-stream",
    extracted_text: null,
  }));

  return {
    title: title ?? null,
    description: description ?? null,
    buyer: buyer ?? null,
    cpv_main: cpvMain ?? null,
    estimated_value: valueNum,
    deadline: deadline ?? null,
    attachments,
  };
}

export async function getOeffentlicheVergabeDetail(noticeId: string): Promise<{
  notice: NoticeDetail | null;
  raw: any | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const xml = await fetchNoticeXml(noticeId);
  if (!xml) {
    warnings.push(`oeffentlichevergabe detail: notice ${noticeId} not found or unreachable.`);
    return { notice: null, raw: null, warnings };
  }

  const meta = await parseXmlMeta(xml);
  const lots: NoticeLot[] = []; // lot extraction is best done via CSV; skip in detail.

  const detail: NoticeDetail = {
    id: noticeId,
    source: "oeffentlichevergabe",
    title: meta.title || `Bekanntmachung ${noticeId.slice(0, 8)}`,
    description: meta.description ?? "",
    cpv_main: meta.cpv_main,
    cpv_extra: [],
    value_eur: meta.estimated_value,
    deadline: meta.deadline,
    nuts: null,
    buyer_name: meta.buyer ?? "(unbekannt)",
    buyer_id: null,
    url: `${BASE}/tenders/${encodeURIComponent(noticeId)}`,
    published_at: new Date().toISOString(),
    full_text: meta.description ?? "",
    lots,
    attachments: meta.attachments,
    eforms_xml: xml,
    ocds_json: null,
  };

  return { notice: detail, raw: { xml }, warnings };
}
