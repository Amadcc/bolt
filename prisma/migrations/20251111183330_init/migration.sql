-- CreateEnum
CREATE TYPE "SnipeStatus" AS ENUM ('PENDING', 'ANALYZING', 'EXECUTING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "subscriptionTier" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'solana',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amount" DECIMAL(30,0) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "transactionSignature" TEXT,
    "commissionUsd" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HoneypotCheck" (
    "tokenMint" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "isHoneypot" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,

    CONSTRAINT "HoneypotCheck_pkey" PRIMARY KEY ("tokenMint")
);

-- CreateTable
CREATE TABLE "SnipeConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoTrading" BOOLEAN NOT NULL DEFAULT false,
    "lastAutomationAt" TIMESTAMP(3),
    "buyAmountLamports" BIGINT NOT NULL DEFAULT 100000000,
    "slippageBps" INTEGER NOT NULL DEFAULT 500,
    "minLiquidityLamports" BIGINT,
    "maxLiquidityLamports" BIGINT,
    "minMarketCapUsd" INTEGER,
    "maxMarketCapUsd" INTEGER,
    "maxHoneypotRisk" INTEGER NOT NULL DEFAULT 30,
    "maxBuysPerHour" INTEGER NOT NULL DEFAULT 10,
    "maxBuysPerDay" INTEGER NOT NULL DEFAULT 50,
    "whitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blacklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notifyOnSuccess" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnipeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnipeExecution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "tokenName" TEXT,
    "status" "SnipeStatus" NOT NULL DEFAULT 'PENDING',
    "buyAmountLamports" BIGINT NOT NULL,
    "outputAmountTokens" BIGINT,
    "honeypotScore" INTEGER,
    "liquidityLamports" BIGINT,
    "marketCapUsd" INTEGER,
    "holderCount" INTEGER,
    "top10HolderPercent" DOUBLE PRECISION,
    "creatorHolderPercent" DOUBLE PRECISION,
    "filterReason" TEXT,
    "transactionSignature" TEXT,
    "priorityFeeLamports" BIGINT,
    "slippageBps" INTEGER,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analyzedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "analysisDurationMs" INTEGER,
    "executionDurationMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "errorDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SnipeExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_publicKey_key" ON "Wallet"("publicKey");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_transactionSignature_key" ON "Order"("transactionSignature");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "HoneypotCheck_checkedAt_idx" ON "HoneypotCheck"("checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SnipeConfig_userId_key" ON "SnipeConfig"("userId");

-- CreateIndex
CREATE INDEX "SnipeConfig_userId_idx" ON "SnipeConfig"("userId");

-- CreateIndex
CREATE INDEX "SnipeConfig_enabled_idx" ON "SnipeConfig"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "SnipeExecution_transactionSignature_key" ON "SnipeExecution"("transactionSignature");

-- CreateIndex
CREATE INDEX "SnipeExecution_userId_status_idx" ON "SnipeExecution"("userId", "status");

-- CreateIndex
CREATE INDEX "SnipeExecution_userId_createdAt_idx" ON "SnipeExecution"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SnipeExecution_status_idx" ON "SnipeExecution"("status");

-- CreateIndex
CREATE INDEX "SnipeExecution_tokenMint_idx" ON "SnipeExecution"("tokenMint");

-- CreateIndex
CREATE INDEX "SnipeExecution_discoveredAt_idx" ON "SnipeExecution"("discoveredAt");

-- CreateIndex
CREATE INDEX "SnipeExecution_success_idx" ON "SnipeExecution"("success");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnipeConfig" ADD CONSTRAINT "SnipeConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnipeExecution" ADD CONSTRAINT "SnipeExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

