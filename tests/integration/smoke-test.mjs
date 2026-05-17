#!/usr/bin/env node
/**
 * vergabe-mcp v1.0.0 — End-to-end smoke tests against live BKMS + TED APIs.
 *
 * Two layers:
 *   - Layer A: import tool handlers directly from dist/, call with sample args,
 *              assert response shape + content.
 *   - Layer B: spawn `node dist/index.js` as subprocess, send JSON-RPC over
 *              stdio (initialize → tools/list → tools/call), parse responses.
 *
 * Goal: verify all 4 tools work as advertised BEFORE npm publish.
 * Bug policy: tests document failures, they do NOT fix bugs autonomously.
 *
 * Run from repo root:  node tests/integration/smoke-test.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolvePath(__dirname, "..", "..");
const DIST_DIR = resolvePath(REPO_ROOT, "dist");

// ---------- result tracking ----------
const results = [];

function record(name, passed, notes = "") {
  results.push({ name, passed, notes });
  const mark = passed ? "PASS" : "FAIL";
  process.stderr.write(`[${mark}] ${name}${notes ? " — " + notes : ""}\n`);
}

function bug(location, description, proposedFix = "") {
  bugsFound.push({ location, description, proposedFix });
  process.stderr.write(`[BUG] ${location}: ${description}\n`);
}

const bugsFound = [];

// ---------- helpers ----------
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assertHasShape(notice, requiredKeys) {
  const missing = requiredKeys.filter((k) => !(k in notice));
  return missing.length === 0 ? null : `missing keys: ${missing.join(", ")}`;
}

function summarizeNotice(n) {
  if (!n) return "<null>";
  return `id=${n.id?.slice(0, 30) ?? "?"}... source=${n.source} title="${(n.title ?? "").slice(0, 50)}..." buyer="${(n.buyer_name ?? "").slice(0, 40)}"`;
}

// ISO date helpers
function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const TODAY_ISO = new Date().toISOString().slice(0, 10);

// ---------- Layer A: direct unit-level tests ----------
async function layerA() {
  process.stderr.write("\n========= LAYER A: direct tool handlers =========\n\n");

  if (!existsSync(resolvePath(DIST_DIR, "tools", "search_notices.js"))) {
    record("Layer A precondition: dist exists", false, "dist/ missing; run `npm run build`");
    return;
  }

  // Dynamic import (ESM) of compiled handlers.
  const searchMod = await import(
    pathToFileURL(resolvePath(DIST_DIR, "tools", "search_notices.js")).href
  );
  const detailMod = await import(
    pathToFileURL(resolvePath(DIST_DIR, "tools", "get_notice_detail.js")).href
  );
  const buyerMod = await import(
    pathToFileURL(resolvePath(DIST_DIR, "tools", "list_buyer_history.js")).href
  );
  const downloadMod = await import(
    pathToFileURL(resolvePath(DIST_DIR, "tools", "download_documents.js")).href
  );

  // ----- Test A: search_notices BKMS-only -----
  let firstBkmsNotice = null;
  try {
    const out = await searchMod.runSearchNotices({
      cpv_prefix: ["72"], // IT services (72000000)
      publication_date_from: isoDaysAgo(14),
      publication_date_to: TODAY_ISO,
      country: "DE",
      source: "oeffentlichevergabe",
      max_results: 10,
    });

    const shapeErr = assertHasShape(out, [
      "notices",
      "total",
      "retrieved_at",
      "sources_used",
      "warnings",
    ]);
    if (shapeErr) {
      record("search_notices Test A (BKMS, CPV 72, 14d)", false, shapeErr);
    } else if (!Array.isArray(out.notices)) {
      record("search_notices Test A (BKMS, CPV 72, 14d)", false, "notices not array");
    } else if (out.notices.length === 0) {
      // Could be: no notices in window, OR endpoint broken with warning.
      const wstr = (out.warnings || []).join(" | ");
      const looksBroken = /HTTP [45]\d\d|fetch failed|not found/i.test(wstr);
      if (looksBroken) {
        record(
          "search_notices Test A (BKMS, CPV 72, 14d)",
          false,
          `0 results + warnings suggest endpoint broken: ${wstr.slice(0, 200)}`
        );
        bug(
          "src/sources/oeffentlichevergabe.ts",
          `BKMS search returns 0 results with warnings: ${wstr.slice(0, 250)}`,
          "Verify endpoint path + query params against live Swagger (TODO is already in source)"
        );
      } else {
        record(
          "search_notices Test A (BKMS, CPV 72, 14d)",
          true,
          `0 results (no warnings — empty window plausible). sources_used=${JSON.stringify(out.sources_used)}`
        );
      }
    } else {
      // Got results — sample one and validate Notice schema.
      const sample = out.notices[0];
      const missingShape = assertHasShape(sample, [
        "id",
        "source",
        "title",
        "cpv_main",
        "buyer_name",
        "published_at",
        "url",
      ]);
      if (missingShape) {
        record(
          "search_notices Test A (BKMS, CPV 72, 14d)",
          false,
          `${out.notices.length} notices, but sample shape: ${missingShape}`
        );
      } else if (sample.source !== "oeffentlichevergabe") {
        record(
          "search_notices Test A (BKMS, CPV 72, 14d)",
          false,
          `expected source=oeffentlichevergabe, got ${sample.source}`
        );
      } else {
        firstBkmsNotice = sample;
        record(
          "search_notices Test A (BKMS, CPV 72, 14d)",
          true,
          `${out.notices.length} notices. Sample: ${summarizeNotice(sample)}`
        );
      }
    }
  } catch (err) {
    record("search_notices Test A (BKMS, CPV 72, 14d)", false, `threw: ${err.message}`);
    bug("src/tools/search_notices.ts", `BKMS path throws unhandled: ${err.message}`);
  }

  await sleep(1500);

  // ----- Test B: search_notices TED-only -----
  let firstTedNotice = null;
  try {
    const out = await searchMod.runSearchNotices({
      cpv_prefix: ["48"], // Software (48000000)
      publication_date_from: isoDaysAgo(30),
      publication_date_to: TODAY_ISO,
      country: "DE",
      source: "ted",
      max_results: 10,
    });

    const shapeErr = assertHasShape(out, [
      "notices",
      "total",
      "retrieved_at",
      "sources_used",
      "warnings",
    ]);
    if (shapeErr) {
      record("search_notices Test B (TED, CPV 48, 30d)", false, shapeErr);
    } else if (!Array.isArray(out.notices)) {
      record("search_notices Test B (TED, CPV 48, 30d)", false, "notices not array");
    } else if (out.notices.length === 0) {
      const wstr = (out.warnings || []).join(" | ");
      const looksBroken = /HTTP [45]\d\d|fetch failed/i.test(wstr);
      if (looksBroken) {
        record(
          "search_notices Test B (TED, CPV 48, 30d)",
          false,
          `0 results + warnings: ${wstr.slice(0, 200)}`
        );
        bug(
          "src/sources/ted.ts",
          `TED search returns 0 results with HTTP/fetch warnings: ${wstr.slice(0, 250)}`,
          "Verify TED v3 query DSL syntax + endpoint per https://docs.ted.europa.eu/api/"
        );
      } else {
        record(
          "search_notices Test B (TED, CPV 48, 30d)",
          true,
          `0 results (no warnings — empty window plausible)`
        );
      }
    } else {
      const sample = out.notices[0];
      const missing = assertHasShape(sample, [
        "id",
        "source",
        "title",
        "buyer_name",
        "published_at",
        "url",
      ]);
      if (missing) {
        record(
          "search_notices Test B (TED, CPV 48, 30d)",
          false,
          `sample shape: ${missing}`
        );
      } else if (sample.source !== "ted") {
        record(
          "search_notices Test B (TED, CPV 48, 30d)",
          false,
          `expected source=ted, got ${sample.source}`
        );
      } else {
        firstTedNotice = sample;
        record(
          "search_notices Test B (TED, CPV 48, 30d)",
          true,
          `${out.notices.length} notices. Sample: ${summarizeNotice(sample)}`
        );
      }
    }
  } catch (err) {
    record("search_notices Test B (TED, CPV 48, 30d)", false, `threw: ${err.message}`);
    bug("src/tools/search_notices.ts", `TED path throws unhandled: ${err.message}`);
  }

  await sleep(1500);

  // ----- Test C: combined + NUTS Hamburg -----
  try {
    const out = await searchMod.runSearchNotices({
      publication_date_from: isoDaysAgo(30),
      publication_date_to: TODAY_ISO,
      country: "DE",
      source: "both",
      nuts: ["DE6"], // Hamburg
      max_results: 20,
    });

    if (!Array.isArray(out.notices)) {
      record("search_notices Test C (combined + DE6)", false, "notices not array");
    } else {
      const bkmsCount = out.notices.filter((n) => n.source === "oeffentlichevergabe").length;
      const tedCount = out.notices.filter((n) => n.source === "ted").length;
      const expectedSources = ["oeffentlichevergabe", "ted"];
      const sourcesMatch = expectedSources.every((s) => out.sources_used.includes(s));
      if (!sourcesMatch) {
        record(
          "search_notices Test C (combined + DE6)",
          false,
          `sources_used missing one: ${JSON.stringify(out.sources_used)}`
        );
      } else {
        record(
          "search_notices Test C (combined + DE6)",
          true,
          `${out.notices.length} total (BKMS=${bkmsCount}, TED=${tedCount}). Warnings: ${out.warnings.length}`
        );
      }
    }
  } catch (err) {
    record("search_notices Test C (combined + DE6)", false, `threw: ${err.message}`);
  }

  await sleep(1500);

  // ----- Edge: invalid CPV -----
  try {
    const out = await searchMod.runSearchNotices({
      cpv_prefix: ["99999999"],
      publication_date_from: isoDaysAgo(14),
      source: "both",
      max_results: 5,
    });
    if (!Array.isArray(out.notices)) {
      record("search_notices Edge (invalid CPV 99999999)", false, "notices not array");
    } else {
      record(
        "search_notices Edge (invalid CPV 99999999)",
        true,
        `graceful: ${out.notices.length} results, warnings=${out.warnings.length}`
      );
    }
  } catch (err) {
    record(
      "search_notices Edge (invalid CPV 99999999)",
      false,
      `threw instead of returning empty: ${err.message}`
    );
    bug(
      "src/tools/search_notices.ts",
      `Invalid CPV ${"99999999"} causes throw, expected empty array.`,
      "Wrap source calls in try/catch (already done — investigate)"
    );
  }

  await sleep(1500);

  // ----- Test: get_notice_detail (use first BKMS notice if we got one; else TED) -----
  const detailCandidate = firstBkmsNotice ?? firstTedNotice;
  if (!detailCandidate) {
    record(
      "get_notice_detail",
      false,
      "no notice from search to test against (search returned 0 from both sources)"
    );
  } else {
    try {
      const out = await detailMod.runGetNoticeDetail({
        notice_id: detailCandidate.id,
        source: detailCandidate.source,
        include_pdfs: false, // keep test fast; PDF logic still goes through code path when set
      });
      const shape = assertHasShape(out, ["notice", "fetched_at", "warnings", "cache_hit"]);
      if (shape) {
        record("get_notice_detail (real notice)", false, shape);
      } else if (out.notice == null) {
        // Detail endpoint may not work yet — that's a bug worth flagging.
        const wstr = (out.warnings || []).join(" | ");
        record(
          "get_notice_detail (real notice)",
          false,
          `notice=null. warnings: ${wstr.slice(0, 250)}`
        );
        bug(
          `src/sources/${detailCandidate.source === "ted" ? "ted.ts" : "oeffentlichevergabe.ts"}`,
          `get_*_detail returned null for id=${detailCandidate.id}. Warnings: ${wstr.slice(0, 250)}`,
          "Verify detail endpoint URL pattern + response shape"
        );
      } else {
        const detailShape = assertHasShape(out.notice, [
          "id",
          "source",
          "title",
          "full_text",
          "lots",
          "attachments",
          "buyer_name",
        ]);
        if (detailShape) {
          record("get_notice_detail (real notice)", false, `detail shape: ${detailShape}`);
        } else {
          record(
            "get_notice_detail (real notice)",
            true,
            `id=${out.notice.id.slice(0, 30)}... lots=${out.notice.lots.length} att=${out.notice.attachments.length} cache_hit=${out.cache_hit}`
          );
        }
      }
    } catch (err) {
      record("get_notice_detail (real notice)", false, `threw: ${err.message}`);
    }
  }

  await sleep(1500);

  // ----- Edge: invalid notice id -----
  try {
    const out = await detailMod.runGetNoticeDetail({
      notice_id: "DOES-NOT-EXIST-12345",
      source: "oeffentlichevergabe",
      include_pdfs: false,
    });
    if (!("notice" in out)) {
      record("get_notice_detail Edge (bogus id)", false, "missing notice key");
    } else if (out.notice == null) {
      record(
        "get_notice_detail Edge (bogus id)",
        true,
        `graceful null; warnings: ${(out.warnings || []).slice(0, 1).join(" | ").slice(0, 150)}`
      );
    } else {
      record(
        "get_notice_detail Edge (bogus id)",
        false,
        "unexpectedly returned a notice for bogus id"
      );
    }
  } catch (err) {
    record(
      "get_notice_detail Edge (bogus id)",
      false,
      `threw instead of null: ${err.message}`
    );
  }

  await sleep(1500);

  // ----- Test: list_buyer_history (real buyer) -----
  // Use a real buyer name from prior results if available, else use Hamburg default.
  const buyerCandidate =
    firstBkmsNotice?.buyer_name ?? firstTedNotice?.buyer_name ?? "Freie und Hansestadt Hamburg";
  try {
    const out = await buyerMod.runListBuyerHistory({
      buyer_name: buyerCandidate,
      limit: 10,
      years_back: 2,
    });
    const shape = assertHasShape(out, [
      "notices",
      "total",
      "buyer_query",
      "retrieved_at",
      "sources_used",
      "warnings",
    ]);
    if (shape) {
      record(`list_buyer_history ("${buyerCandidate.slice(0, 40)}")`, false, shape);
    } else if (!Array.isArray(out.notices)) {
      record(`list_buyer_history ("${buyerCandidate.slice(0, 40)}")`, false, "notices not array");
    } else {
      // 0 results is acceptable (matching is tolerant but exact name may not hit);
      // we just check it didn't throw and shape is valid.
      record(
        `list_buyer_history ("${buyerCandidate.slice(0, 40)}")`,
        true,
        `${out.notices.length} matches, buyer_query="${out.buyer_query}", warnings=${out.warnings.length}`
      );
    }
  } catch (err) {
    record(
      `list_buyer_history ("${buyerCandidate.slice(0, 40)}")`,
      false,
      `threw: ${err.message}`
    );
  }

  await sleep(1500);

  // ----- Edge: nonexistent buyer -----
  try {
    const out = await buyerMod.runListBuyerHistory({
      buyer_name: "Stadt Atlantis 1234",
      limit: 5,
      years_back: 2,
    });
    if (!Array.isArray(out.notices)) {
      record("list_buyer_history Edge (Atlantis)", false, "notices not array");
    } else if (out.notices.length > 0) {
      record(
        "list_buyer_history Edge (Atlantis)",
        false,
        `unexpectedly got ${out.notices.length} matches for Atlantis`
      );
    } else {
      record(
        "list_buyer_history Edge (Atlantis)",
        true,
        `empty array as expected; warnings=${out.warnings.length}`
      );
    }
  } catch (err) {
    record("list_buyer_history Edge (Atlantis)", false, `threw: ${err.message}`);
  }

  // ----- Test: download_documents stub -----
  try {
    const out = await downloadMod.runDownloadDocuments({
      notice_id: "any-id-here",
      target_dir: "./tmp-test",
      source: "BKMS",
    });
    if (out.status === "not_yet_implemented" && typeof out.message === "string") {
      record(
        "download_documents (stub returns not_yet_implemented)",
        true,
        `status="${out.status}"`
      );
    } else {
      record(
        "download_documents (stub returns not_yet_implemented)",
        false,
        `unexpected output: ${JSON.stringify(out).slice(0, 150)}`
      );
    }
  } catch (err) {
    record(
      "download_documents (stub returns not_yet_implemented)",
      false,
      `threw: ${err.message}`
    );
  }

  return { firstBkmsNotice, firstTedNotice };
}

// ---------- Layer B: MCP stdio protocol ----------
async function layerB() {
  process.stderr.write("\n========= LAYER B: MCP stdio protocol =========\n\n");

  const serverPath = resolvePath(DIST_DIR, "index.js");
  if (!existsSync(serverPath)) {
    record("Layer B precondition: dist/index.js exists", false, "missing dist/index.js");
    return;
  }

  // Spawn the MCP server.
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });

  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));

  let stdoutBuf = "";
  const pending = new Map(); // id -> {resolve, reject}

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    // Parse line-delimited JSON-RPC.
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch (e) {
        // Not JSON — ignore.
      }
    }
  });

  let nextId = 1;
  function rpc(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    const req = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(to);
          resolve(msg);
        },
        reject,
      });
      child.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  let exitCode = null;
  child.on("exit", (code) => {
    exitCode = code;
  });

  try {
    // 1) initialize handshake (MCP requires this before tools/list)
    const initRes = await rpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vergabe-mcp-smoke-test", version: "1.0.0" },
      },
      10_000
    );
    if (initRes.error) {
      record("Layer B: initialize", false, `error: ${JSON.stringify(initRes.error).slice(0, 200)}`);
    } else {
      record(
        "Layer B: initialize",
        true,
        `server: ${initRes.result?.serverInfo?.name}@${initRes.result?.serverInfo?.version}`
      );
    }

    // notifications/initialized (notification, no response expected)
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"
    );

    // 2) tools/list
    const listRes = await rpc("tools/list", {}, 10_000);
    if (listRes.error) {
      record("Layer B: tools/list", false, `error: ${JSON.stringify(listRes.error).slice(0, 200)}`);
    } else {
      const tools = listRes.result?.tools ?? [];
      const names = tools.map((t) => t.name).sort();
      const expected = [
        "vergabe_download_documents",
        "vergabe_get_notice_detail",
        "vergabe_list_buyer_history",
        "vergabe_search_notices",
      ].sort();
      const missing = expected.filter((n) => !names.includes(n));
      if (missing.length === 0) {
        record("Layer B: tools/list", true, `all 4 tools registered: ${names.join(", ")}`);
      } else {
        record("Layer B: tools/list", false, `missing: ${missing.join(", ")}; got: ${names.join(", ")}`);
        bug("src/index.ts", `tools/list missing tools: ${missing.join(", ")}`);
      }
    }

    // 3) tools/call — invoke the stub (fastest, no network)
    const callRes = await rpc(
      "tools/call",
      {
        name: "vergabe_download_documents",
        arguments: {
          notice_id: "test-id",
          target_dir: "./tmp",
          source: "BKMS",
        },
      },
      15_000
    );
    if (callRes.error) {
      record("Layer B: tools/call (stub)", false, `error: ${JSON.stringify(callRes.error).slice(0, 200)}`);
    } else {
      const content = callRes.result?.content?.[0];
      const text = content?.text ?? "";
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // ignore
      }
      if (parsed?.status === "not_yet_implemented") {
        record(
          "Layer B: tools/call (stub)",
          true,
          `stub returned not_yet_implemented as expected`
        );
      } else {
        record(
          "Layer B: tools/call (stub)",
          false,
          `unexpected payload: ${text.slice(0, 200)}`
        );
      }
    }

    // 4) tools/call — quick search (BKMS) to verify wiring
    const searchCall = await rpc(
      "tools/call",
      {
        name: "vergabe_search_notices",
        arguments: {
          source: "oeffentlichevergabe",
          publication_date_from: isoDaysAgo(7),
          publication_date_to: TODAY_ISO,
          cpv_prefix: ["72"],
          max_results: 3,
        },
      },
      45_000
    );
    if (searchCall.error) {
      record(
        "Layer B: tools/call (search)",
        false,
        `error: ${JSON.stringify(searchCall.error).slice(0, 200)}`
      );
    } else {
      const text = searchCall.result?.content?.[0]?.text ?? "";
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // ignore
      }
      if (parsed && Array.isArray(parsed.notices)) {
        record(
          "Layer B: tools/call (search)",
          true,
          `wire works; ${parsed.notices.length} notices, warnings=${parsed.warnings?.length ?? 0}`
        );
      } else {
        record(
          "Layer B: tools/call (search)",
          false,
          `payload not parseable as SearchNoticesOutput: ${text.slice(0, 200)}`
        );
      }
    }
  } catch (err) {
    record("Layer B: rpc loop", false, `threw: ${err.message}`);
  } finally {
    child.stdin.end();
    // Give the server a moment to exit cleanly.
    await new Promise((r) => setTimeout(r, 500));
    if (exitCode === null) child.kill("SIGTERM");
    // Drain stderr for any fatal log.
    const stderrText = stderrChunks.join("");
    if (/fatal/i.test(stderrText)) {
      process.stderr.write("---- server stderr (filtered) ----\n");
      process.stderr.write(stderrText.split("\n").filter((l) => /fatal|error/i.test(l)).join("\n") + "\n");
    }
  }
}

// ---------- main ----------
async function main() {
  process.stderr.write(`vergabe-mcp smoke test — node ${process.version} — repo ${REPO_ROOT}\n`);
  process.stderr.write(`today=${TODAY_ISO}\n`);

  await layerA();
  await layerB();

  // ---------- final summary ----------
  process.stderr.write("\n\n========= SUMMARY =========\n");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  process.stderr.write(`${passed} passed, ${failed} failed (of ${results.length})\n\n`);
  for (const r of results) {
    process.stderr.write(`  [${r.passed ? "PASS" : "FAIL"}] ${r.name}${r.notes ? " — " + r.notes : ""}\n`);
  }
  if (bugsFound.length > 0) {
    process.stderr.write(`\n========= BUGS FOUND (${bugsFound.length}) =========\n`);
    for (const b of bugsFound) {
      process.stderr.write(`  [BUG] ${b.location}\n    ${b.description}\n    fix: ${b.proposedFix || "(none proposed)"}\n`);
    }
  }
  // Emit a machine-parseable JSON line on stdout as the very last thing.
  process.stdout.write(
    JSON.stringify({
      passed,
      failed,
      total: results.length,
      bugs: bugsFound.length,
      results,
      bugsFound,
    }) + "\n"
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err.stack || err.message}\n`);
  process.exit(2);
});
