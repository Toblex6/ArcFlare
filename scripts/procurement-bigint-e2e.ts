// scripts/procurement-bigint-e2e.ts
//
// Focused regression test: GET /api/procurement must serialize BigInt
// resultingJobId safely (was: `TypeError: Do not know how to serialize a BigInt`
// on HIRED postings -> UI `JSON.parse: unexpected end of data`).
//
// Covers: HIRED posting with populated resultingJobId returns a string,
// null stays null, and OPEN/SELECTED/HIRED response shapes stay compatible.
//
// Run: npx tsx scripts/procurement-bigint-e2e.ts (needs DATABASE_URL)

import { prisma } from "../src/lib/prisma";
import { GET } from "../src/app/api/procurement/route";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fakeReq(url: string): any {
  return { url } as any;
}

const EXPECTED_KEYS = [
  "id",
  "clientAgentId",
  "clientSCA",
  "description",
  "budgetMax",
  "status",
  "resultingJobId",
];

async function main(): Promise<void> {
  console.log("=== procurement BigInt GET serialization e2e ===");
  const suffix = Date.now().toString(36);

  const scaAddress = `0x${suffix.padStart(8, "0")}${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`;
  const agent: any = await (prisma as any).agentRegistry.create({
    data: {
      name: `BigintProbe-${suffix}`,
      tokenId: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
      scaAddress,
      circleWalletId: null,
      ownerNode: "test",
      status: "ACTIVE_AGENT_PROVISIONED",
      description: "bigint serialization probe",
      skills: [],
      reputation: 50,
      merchantId: null,
    },
  });

  const hiredJobId = BigInt(700000 + Math.floor(Math.random() * 10000));
  const descOpen = `bigint-probe-OPEN-${suffix}`;
  const descSelected = `bigint-probe-SELECTED-${suffix}`;
  const descHired = `bigint-probe-HIRED-${suffix}`;

  const created: string[] = [];
  try {
    const open: any = await (prisma as any).procurementPosting.create({
      data: {
        clientAgentId: agent.id,
        clientSCA: agent.scaAddress,
        description: descOpen,
        budgetMax: "1000000",
        status: "OPEN",
      },
    });
    const selected: any = await (prisma as any).procurementPosting.create({
      data: {
        clientAgentId: agent.id,
        clientSCA: agent.scaAddress,
        description: descSelected,
        budgetMax: "1000000",
        status: "SELECTED",
      },
    });
    const hired: any = await (prisma as any).procurementPosting.create({
      data: {
        clientAgentId: agent.id,
        clientSCA: agent.scaAddress,
        description: descHired,
        budgetMax: "1000000",
        status: "HIRED",
        resultingJobId: hiredJobId,
      },
    });
    created.push(open.id, selected.id, hired.id);

    // 1. Raw Prisma row really carries a BigInt (bug precondition).
    const rawHired: any = await (prisma as any).procurementPosting.findUnique({ where: { id: hired.id } });
    ok("precondition: raw HIRED resultingJobId is bigint", typeof rawHired.resultingJobId === "bigint");

    // 2. Raw JSON.stringify throws — this is the original crash.
    let rawThrows = false;
    try {
      JSON.stringify(rawHired);
    } catch (e: any) {
      rawThrows = /BigInt/i.test(e?.message ?? "");
    }
    ok("precondition: raw row JSON.stringify throws BigInt error", rawThrows);

    // 3. GET status=HIRED returns valid JSON with string resultingJobId.
    const hiredRes: any = await GET(fakeReq("http://localhost/api/procurement?status=HIRED&limit=100"));
    const hiredText: string = await hiredRes.text();
    let hiredBody: any = null;
    try {
      hiredBody = JSON.parse(hiredText);
    } catch {
      hiredBody = null;
    }
    ok("GET HIRED: HTTP 200", hiredRes.status === 200, `status ${hiredRes.status}`);
    ok("GET HIRED: response is valid JSON", hiredBody !== null);
    const hiredRow: any = (hiredBody?.postings ?? []).find((p: any) => p.description === descHired);
    ok("GET HIRED: probe posting present", !!hiredRow);
    ok(
      "GET HIRED: resultingJobId is string when populated",
      !!hiredRow && typeof hiredRow.resultingJobId === "string" && hiredRow.resultingJobId === hiredJobId.toString(),
      `got ${String(hiredRow?.resultingJobId)} (${typeof hiredRow?.resultingJobId})`
    );
    ok(
      "GET HIRED: shape compatible",
      !!hiredRow && EXPECTED_KEYS.every((k) => k in hiredRow) && typeof hiredRow.budgetMax === "string",
      hiredRow ? `keys: ${Object.keys(hiredRow).join(",")}` : "missing row"
    );

    // 4. GET status=OPEN: null stays null.
    const openRes: any = await GET(fakeReq("http://localhost/api/procurement?status=OPEN&limit=100"));
    const openBody: any = JSON.parse(await openRes.text());
    const openRow: any = (openBody?.postings ?? []).find((p: any) => p.description === descOpen);
    ok("GET OPEN: HTTP 200 + valid JSON", openRes.status === 200 && openBody?.success === true);
    ok("GET OPEN: probe posting present", !!openRow);
    ok("GET OPEN: resultingJobId null stays null", !!openRow && openRow.resultingJobId === null);
    ok(
      "GET OPEN: shape compatible",
      !!openRow && EXPECTED_KEYS.every((k) => k in openRow),
      openRow ? `keys: ${Object.keys(openRow).join(",")}` : "missing row"
    );

    // 5. GET status=SELECTED: null stays null, shape compatible.
    const selRes: any = await GET(fakeReq("http://localhost/api/procurement?status=SELECTED&limit=100"));
    const selBody: any = JSON.parse(await selRes.text());
    const selRow: any = (selBody?.postings ?? []).find((p: any) => p.description === descSelected);
    ok("GET SELECTED: HTTP 200 + valid JSON", selRes.status === 200 && selBody?.success === true);
    ok("GET SELECTED: probe posting present", !!selRow);
    ok("GET SELECTED: resultingJobId null stays null", !!selRow && selRow.resultingJobId === null);
    ok(
      "GET SELECTED: shape compatible",
      !!selRow && EXPECTED_KEYS.every((k) => k in selRow),
      selRow ? `keys: ${Object.keys(selRow).join(",")}` : "missing row"
    );
  } finally {
    for (const id of created) {
      await (prisma as any).procurementPosting.delete({ where: { id } }).catch(() => {});
    }
    await (prisma as any).agentRegistry.delete({ where: { id: agent.id } }).catch(() => {});
    await (prisma as any).$disconnect().catch(() => {});
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
