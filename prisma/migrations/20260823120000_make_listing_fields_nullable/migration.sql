-- AlterTable: make ApiListing service fields nullable for agent listings
ALTER TABLE "ApiListing" ALTER COLUMN "pricePerRequest" DROP NOT NULL;
ALTER TABLE "ApiListing" ALTER COLUMN "targetUrl" DROP NOT NULL;
