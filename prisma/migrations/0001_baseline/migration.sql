-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "PaymentLog" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'send',
    "merchant" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "arcTxHash" TEXT,
    "cctpSourceTxHash" TEXT,
    "webhookUrl" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "agentSCA" TEXT,
    "circleTxId" TEXT,
    "payerSCA" TEXT,
    "merchantSCA" TEXT,
    "merchantId" TEXT,
    "listingId" TEXT,
    "gatewayReference" TEXT,
    "upstreamOk" BOOLEAN,
    "upstreamStatus" INTEGER,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRegistry" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "scaAddress" TEXT NOT NULL,
    "circleWalletId" TEXT,
    "ownerNode" TEXT NOT NULL,
    "metadataURI" TEXT,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "skills" JSONB,
    "pricing" JSONB,
    "reputation" INTEGER NOT NULL DEFAULT 50,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "merchantId" TEXT,

    CONSTRAINT "AgentRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiListing" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pricePerRequest" TEXT NOT NULL,
    "docsUrl" TEXT,
    "targetUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "merchantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ownerEmail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "scaAddress" TEXT,
    "capabilities" TEXT[],
    "pricePerJob" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registryId" INTEGER,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Escrow" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "depositorSCA" TEXT NOT NULL,
    "beneficiarySCA" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "condition" TEXT,
    "contractEscrowId" TEXT,
    "deadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "merchantId" TEXT,
    "txHash" TEXT,
    "releaseTxHash" TEXT,
    "disputeTxHash" TEXT,
    "disputeReason" TEXT,
    "disputedBy" TEXT,
    "depositorConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "beneficiaryConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "webhookUrl" TEXT,

    CONSTRAINT "Escrow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stream" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "senderSCA" TEXT NOT NULL,
    "receiverSCA" TEXT NOT NULL,
    "ratePerSecond" DOUBLE PRECISION NOT NULL,
    "totalDeposited" DOUBLE PRECISION NOT NULL,
    "totalStreamed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "status" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "txHash" TEXT,
    "webhookUrl" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "contractStreamId" TEXT,

    CONSTRAINT "Stream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NanoPayment" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "agentSCA" TEXT NOT NULL,
    "merchantSCA" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "description" TEXT,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "batchRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "NanoPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "apiKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificationCode" TEXT,
    "verificationCodeExpiresAt" TIMESTAMP(3),
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "resetCode" TEXT,
    "resetCodeExpiresAt" TIMESTAMP(3),
    "walletProvider" TEXT NOT NULL DEFAULT 'CIRCLE',
    "walletAddress" TEXT,
    "circleWalletId" TEXT,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletSignatureRequest" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actionRefId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "signedTx" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletSignatureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumerAccount" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "walletType" TEXT NOT NULL DEFAULT 'CIRCLE',
    "circleWalletId" TEXT,
    "walletSetId" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentId" TEXT NOT NULL,
    "merchantId" TEXT,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobNanopaymentStream" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "workerAddress" TEXT NOT NULL,
    "totalBudget" TEXT NOT NULL,
    "trancheCount" INTEGER NOT NULL,
    "tranchesReleased" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobNanopaymentStream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobNanopaymentTranche" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "requirementIndex" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobNanopaymentTranche_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erc8183_jobs" (
    "id" TEXT NOT NULL,
    "jobId" BIGINT NOT NULL,
    "clientSCA" TEXT NOT NULL,
    "providerSCA" TEXT NOT NULL,
    "evaluatorSCA" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "budget" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "deliverableHash" TEXT,
    "reasonHash" TEXT,
    "txHashes" TEXT[],
    "hook" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiredAt" TIMESTAMP(3) NOT NULL,
    "agentId" TEXT,
    "merchantId" TEXT,

    CONSTRAINT "erc8183_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applications" (
    "id" TEXT NOT NULL,
    "jobId" BIGINT NOT NULL,
    "applicantAddress" TEXT NOT NULL,
    "proposedAmount" TEXT,
    "pitch" TEXT NOT NULL,
    "portfolioLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erc8183_job_events" (
    "id" TEXT NOT NULL,
    "jobId" BIGINT NOT NULL,
    "eventType" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB,

    CONSTRAINT "erc8183_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circle_wallets" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "walletSetId" TEXT NOT NULL,
    "blockchain" TEXT NOT NULL DEFAULT 'ARC-TESTNET',
    "accountType" TEXT NOT NULL DEFAULT 'SCA',
    "label" TEXT,
    "ownerEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "agentRegistryId" INTEGER,

    CONSTRAINT "circle_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circle_wallet_sets" (
    "id" TEXT NOT NULL,
    "walletSetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "circle_wallet_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledPayment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "payerSCA" TEXT NOT NULL,
    "payerWalletId" TEXT,
    "receiverSCA" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "intervalDays" INTEGER NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "maxRuns" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "webhookUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollBatch" (
    "id" TEXT NOT NULL,
    "batchRef" TEXT NOT NULL,
    "payerSCA" TEXT NOT NULL,
    "payerWalletId" TEXT,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "recipientCount" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "results" JSONB,
    "webhookUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PayrollBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x402_eoa_wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "keyIv" TEXT NOT NULL,
    "keyAuthTag" TEXT NOT NULL,
    "merchantId" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "x402_eoa_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentBrainMemory" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "message" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentBrainMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantBudget" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "monthlyLimit" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantReminder" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "intervalDays" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "webhookUrl" TEXT,
    "mutedEvents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeEvidence" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL,
    "mimeType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeAnalysis" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DisputeAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLog_reference_key" ON "PaymentLog"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLog_idempotencyKey_key" ON "PaymentLog"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLog_cctpSourceTxHash_key" ON "PaymentLog"("cctpSourceTxHash");

-- CreateIndex
CREATE INDEX "PaymentLog_listingId_idx" ON "PaymentLog"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRegistry_tokenId_key" ON "AgentRegistry"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRegistry_scaAddress_key" ON "AgentRegistry"("scaAddress");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRegistry_idempotencyKey_key" ON "AgentRegistry"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ApiListing_slug_key" ON "ApiListing"("slug");

-- CreateIndex
CREATE INDEX "ApiListing_merchantId_idx" ON "ApiListing"("merchantId");

-- CreateIndex
CREATE INDEX "ApiListing_status_idx" ON "ApiListing"("status");

-- CreateIndex
CREATE INDEX "ApiListing_slug_idx" ON "ApiListing"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_walletAddress_key" ON "Agent"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Escrow_reference_key" ON "Escrow"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Escrow_idempotencyKey_key" ON "Escrow"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Stream_reference_key" ON "Stream"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Stream_idempotencyKey_key" ON "Stream"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "NanoPayment_idempotencyKey_key" ON "NanoPayment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_apiKey_key" ON "Merchant"("apiKey");

-- CreateIndex
CREATE INDEX "WalletSignatureRequest_merchantId_idx" ON "WalletSignatureRequest"("merchantId");

-- CreateIndex
CREATE INDEX "WalletSignatureRequest_status_idx" ON "WalletSignatureRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumerAccount_walletAddress_key" ON "ConsumerAccount"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumerAccount_email_key" ON "ConsumerAccount"("email");

-- CreateIndex
CREATE UNIQUE INDEX "JobNanopaymentStream_jobId_key" ON "JobNanopaymentStream"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobNanopaymentTranche_jobId_requirementIndex_key" ON "JobNanopaymentTranche"("jobId", "requirementIndex");

-- CreateIndex
CREATE UNIQUE INDEX "erc8183_jobs_jobId_key" ON "erc8183_jobs"("jobId");

-- CreateIndex
CREATE INDEX "erc8183_jobs_jobId_idx" ON "erc8183_jobs"("jobId");

-- CreateIndex
CREATE INDEX "erc8183_jobs_clientSCA_idx" ON "erc8183_jobs"("clientSCA");

-- CreateIndex
CREATE INDEX "erc8183_jobs_providerSCA_idx" ON "erc8183_jobs"("providerSCA");

-- CreateIndex
CREATE INDEX "erc8183_jobs_evaluatorSCA_idx" ON "erc8183_jobs"("evaluatorSCA");

-- CreateIndex
CREATE INDEX "erc8183_jobs_status_idx" ON "erc8183_jobs"("status");

-- CreateIndex
CREATE INDEX "job_applications_jobId_idx" ON "job_applications"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_jobId_applicantAddress_key" ON "job_applications"("jobId", "applicantAddress");

-- CreateIndex
CREATE INDEX "erc8183_job_events_jobId_idx" ON "erc8183_job_events"("jobId");

-- CreateIndex
CREATE INDEX "erc8183_job_events_eventType_idx" ON "erc8183_job_events"("eventType");

-- CreateIndex
CREATE INDEX "erc8183_job_events_txHash_idx" ON "erc8183_job_events"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "circle_wallets_walletId_key" ON "circle_wallets"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "circle_wallets_address_key" ON "circle_wallets"("address");

-- CreateIndex
CREATE INDEX "circle_wallets_address_idx" ON "circle_wallets"("address");

-- CreateIndex
CREATE INDEX "circle_wallets_walletSetId_idx" ON "circle_wallets"("walletSetId");

-- CreateIndex
CREATE INDEX "circle_wallets_label_idx" ON "circle_wallets"("label");

-- CreateIndex
CREATE UNIQUE INDEX "circle_wallet_sets_walletSetId_key" ON "circle_wallet_sets"("walletSetId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPayment_reference_key" ON "ScheduledPayment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPayment_idempotencyKey_key" ON "ScheduledPayment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollBatch_batchRef_key" ON "PayrollBatch"("batchRef");

-- CreateIndex
CREATE UNIQUE INDEX "x402_eoa_wallets_address_key" ON "x402_eoa_wallets"("address");

-- CreateIndex
CREATE UNIQUE INDEX "x402_eoa_wallets_merchantId_key" ON "x402_eoa_wallets"("merchantId");

-- CreateIndex
CREATE INDEX "AgentBrainMemory_sessionId_idx" ON "AgentBrainMemory"("sessionId");

-- CreateIndex
CREATE INDEX "MerchantBudget_merchantId_idx" ON "MerchantBudget"("merchantId");

-- CreateIndex
CREATE INDEX "MerchantReminder_merchantId_idx" ON "MerchantReminder"("merchantId");

-- CreateIndex
CREATE INDEX "MerchantReminder_dueDate_idx" ON "MerchantReminder"("dueDate");

-- CreateIndex
CREATE INDEX "Notification_merchantId_idx" ON "Notification"("merchantId");

-- CreateIndex
CREATE INDEX "Notification_merchantId_read_idx" ON "Notification"("merchantId", "read");

-- CreateIndex
CREATE INDEX "Notification_type_idx" ON "Notification"("type");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_merchantId_key" ON "NotificationPreference"("merchantId");

-- CreateIndex
CREATE INDEX "DisputeEvidence_reference_idx" ON "DisputeEvidence"("reference");

-- CreateIndex
CREATE INDEX "DisputeAnalysis_reference_idx" ON "DisputeAnalysis"("reference");

-- CreateIndex
CREATE INDEX "DisputeAnalysis_reference_version_idx" ON "DisputeAnalysis"("reference", "version");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "AgentRegistry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erc8183_jobs" ADD CONSTRAINT "erc8183_jobs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "erc8183_jobs"("jobId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_wallets" ADD CONSTRAINT "circle_wallets_agentRegistryId_fkey" FOREIGN KEY ("agentRegistryId") REFERENCES "AgentRegistry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_wallets" ADD CONSTRAINT "circle_wallets_walletSetId_fkey" FOREIGN KEY ("walletSetId") REFERENCES "circle_wallet_sets"("walletSetId") ON DELETE RESTRICT ON UPDATE CASCADE;

