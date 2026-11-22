/**
 * nav-escrow-copy-tests.ts
 *
 * Static regression tests for two deliberate product decisions:
 *
 *   1. Streams is removed from NAVIGATION ONLY (sidebar + sitemap + homepage
 *      navbar), while the page, its APIs and the deployed ArcFlareStream
 *      contract stay in the tree. Deleting the code or the contract is NOT
 *      the change; hiding the entry point is.
 *   2. The escrow dashboard describes the contract by its current name
 *      (FlareHQEscrow), not the retired ArcFlareEscrow label.
 *
 * Content-based proofs only — no server, DB, chain or funds.
 * Run: npx tsx scripts/nav-escrow-copy-tests.ts
 */

import fs from "fs";
import path from "path";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ": " + detail : ""}`); console.log(`  FAIL ${name} - ${detail}`); }
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(root, p));

// ── 1. Sidebar: no Streams entry ─────────────────────────────────────────
const sidebar = read("src/components/DashboardSidebar.tsx");
ok("sidebar has no Streams nav label", !/label:\s*['"]Streams['"]/.test(sidebar));
ok("sidebar has no /streams href", !sidebar.includes("'/streams'") && !sidebar.includes('"/streams"'));
ok("sidebar documents the intentional removal", /Streams is intentionally NOT navigable/.test(sidebar));

// ── 2. Sitemap: /streams not advertised ──────────────────────────────────
const sitemap = read("src/app/sitemap.ts");
ok("sitemap does not list /streams", !/['"]\/streams['"]/.test(sitemap));
ok("sitemap keeps the required public routes", ["/marketplace", "/agents", "/flarehq-jobs"].every((r) => sitemap.includes(r)));

// ── 3. Homepage navbar: no Streams route ─────────────────────────────────
const navbar = read("src/components/home/HomeNavbar.tsx");
ok("homepage navbar has no /streams route", !navbar.includes("/streams"));

// ── 4. Code and contract are kept (not deleted) ──────────────────────────
ok("streams page still exists", exists("src/app/streams/page.tsx"));
ok("streams API route still exists", exists("src/app/api/streams/route.ts"));
ok("streams release API still exists", exists("src/app/api/streams/[reference]/release/route.ts"));
ok("streams close API still exists", exists("src/app/api/streams/[reference]/close/route.ts"));
ok("ArcFlareStream contract source still exists", exists("contracts/ArcFlareStream.sol"));
ok("streams page still renders the shared sidebar", read("src/app/streams/page.tsx").includes("<DashboardSidebar"));

// ── 5. Escrow subtitle uses the current contract name ────────────────────
const escrowPage = read("src/app/escrow/page.tsx");
ok("escrow subtitle names FlareHQEscrow", escrowPage.includes("via FlareHQEscrow contract"));
ok("escrow subtitle no longer says ArcFlareEscrow", !escrowPage.includes("via ArcFlareEscrow contract"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nFailures:\n" + failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
