// One-off: remove the "Twitter" API listing from the marketplace.
// Run: node scripts/remove-twitter-listing.mjs [--dry-run]
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

try {
    const candidates = await prisma.apiListing.findMany({
        where: { name: { equals: "Twitter", mode: "insensitive" } },
        select: { id: true, slug: true, name: true, pricePerRequest: true, status: true, merchantId: true, createdAt: true },
    });
    if (candidates.length === 0) {
        console.log("No 'Twitter' listing found — nothing to do.");
    } else {
        console.log("Found listing(s) to remove:");
        for (const c of candidates) console.log(`  ${c.id} ${c.slug} "${c.name}" ${c.pricePerRequest} [${c.status}] merchant=${c.merchantId} created=${c.createdAt?.toISOString?.()}`);
        if (dryRun) {
            console.log("Dry run — no rows deleted. Re-run without --dry-run to delete.");
        } else {
            const res = await prisma.apiListing.deleteMany({ where: { id: { in: candidates.map((c) => c.id) } } });
            console.log(`Deleted ${res.count} listing(s).`);
        }
    }
} catch (e) {
    console.error("Failed:", e.message);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
