#!/usr/bin/env node
/**
 * pack-mcpb.mjs — build vergabe-mcp.mcpb (Anthropic Desktop Extension)
 *
 * Workflow:
 *   1. Read version from manifest.json (must match package.json)
 *   2. Stage to .mcpb-staging/ with the layout:
 *        manifest.json
 *        package.json
 *        server/             <- dist/ renamed
 *        node_modules/       <- production-only
 *   3. Run `npx @anthropic-ai/mcpb pack` against the staging dir to produce
 *      vergabe-mcp.mcpb in the repo root.
 *   4. Report file size.
 *
 * Pre-conditions:
 *   - `npm run build` ran (dist/ populated)
 *   - manifest.json exists in repo root
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STAGING = join(REPO_ROOT, ".mcpb-staging");
const OUT_FILE = join(REPO_ROOT, "vergabe-mcp.mcpb");

function log(msg) {
  process.stderr.write(`[pack-mcpb] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[pack-mcpb] ERROR: ${msg}\n`);
  process.exit(1);
}

// --- Step 1: sanity check ---------------------------------------------------
const manifestPath = join(REPO_ROOT, "manifest.json");
const pkgPath = join(REPO_ROOT, "package.json");
const distPath = join(REPO_ROOT, "dist");

if (!existsSync(manifestPath)) fail("manifest.json missing in repo root");
if (!existsSync(pkgPath)) fail("package.json missing");
if (!existsSync(distPath)) fail("dist/ missing — run `npm run build` first");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

if (manifest.version !== pkg.version) {
  fail(
    `Version mismatch: manifest.json=${manifest.version}, package.json=${pkg.version}. ` +
      `Keep them in sync.`,
  );
}

log(`version: ${manifest.version}`);

// --- Step 2: clean staging --------------------------------------------------
if (existsSync(STAGING)) {
  log("clearing previous staging dir");
  rmSync(STAGING, { recursive: true, force: true });
}
mkdirSync(STAGING, { recursive: true });

if (existsSync(OUT_FILE)) {
  log(`removing previous ${OUT_FILE}`);
  rmSync(OUT_FILE, { force: true });
}

// --- Step 3: stage files ----------------------------------------------------
log("staging manifest.json");
cpSync(manifestPath, join(STAGING, "manifest.json"));

// Slimmed package.json (drop devDeps, scripts noise — keep only what helps the runtime)
const stagedPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: pkg.type,
  main: "server/index.js",
  license: pkg.license,
  author: pkg.author,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
};
writeFileSync(join(STAGING, "package.json"), JSON.stringify(stagedPkg, null, 2));

log("staging dist/ -> server/");
cpSync(distPath, join(STAGING, "server"), { recursive: true });

// --- Step 4: production node_modules ---------------------------------------
// We install fresh prod deps inside the staging dir so we get a tree without
// devDependencies, regardless of the dev install state.
log("installing production node_modules into staging (npm install --omit=dev --no-package-lock)");
const npmInstall = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["install", "--omit=dev", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund"],
  {
    cwd: STAGING,
    stdio: "inherit",
    env: process.env,
  },
);
if (npmInstall.status !== 0) {
  fail(`npm install in staging failed with code ${npmInstall.status}`);
}

// --- Step 5: pack via @anthropic-ai/mcpb -----------------------------------
log("packing via @anthropic-ai/mcpb pack");
const pack = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--yes", "@anthropic-ai/mcpb", "pack", STAGING, OUT_FILE],
  {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  },
);
if (pack.status !== 0) {
  fail(`mcpb pack failed with code ${pack.status}`);
}

// --- Step 6: report ---------------------------------------------------------
if (!existsSync(OUT_FILE)) fail(`expected ${OUT_FILE} but not found after pack`);
const bytes = statSync(OUT_FILE).size;
const mb = (bytes / 1024 / 1024).toFixed(2);
log(`done: ${OUT_FILE} (${mb} MB)`);

// Cleanup staging (keep .mcpb in repo root for the release)
log("removing staging dir");
rmSync(STAGING, { recursive: true, force: true });
