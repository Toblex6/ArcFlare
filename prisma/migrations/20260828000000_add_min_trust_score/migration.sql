-- AlterTable: add minTrustScore to agent_treasury_policies (Build 4 trust-aware hiring)
ALTER TABLE "agent_treasury_policies" ADD COLUMN "minTrustScore" INTEGER;
