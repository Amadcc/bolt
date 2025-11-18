-- CreateTable
CREATE TABLE "SniperOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "amountIn" DECIMAL(30,0) NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "priorityFee" TEXT NOT NULL,
    "useJito" BOOLEAN NOT NULL DEFAULT false,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "takeProfitPct" DECIMAL(10,2),
    "stopLossPct" DECIMAL(10,2),
    "status" TEXT NOT NULL,
    "stateData" JSONB NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "executionTimeMs" INTEGER,
    "signature" TEXT,
    "slot" BIGINT,
    "inputAmount" DECIMAL(30,0),
    "outputAmount" DECIMAL(30,0),
    "priceImpactPct" DECIMAL(10,4),
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SniperOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SniperPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "entrySignature" TEXT NOT NULL,
    "amountIn" DECIMAL(30,0) NOT NULL,
    "amountOut" DECIMAL(30,0) NOT NULL,
    "entryPriceImpactPct" DECIMAL(10,4) NOT NULL,
    "currentBalance" DECIMAL(30,0) NOT NULL,
    "takeProfitPct" DECIMAL(10,2),
    "stopLossPct" DECIMAL(10,2),
    "trailingStopLoss" BOOLEAN NOT NULL DEFAULT false,
    "highestPriceSeen" DECIMAL(20,10),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "exitSignature" TEXT,
    "realizedPnlLamports" DECIMAL(30,0),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SniperPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SniperOrder_signature_key" ON "SniperOrder"("signature");

-- CreateIndex
CREATE INDEX "SniperOrder_userId_status_idx" ON "SniperOrder"("userId", "status");

-- CreateIndex
CREATE INDEX "SniperOrder_status_createdAt_idx" ON "SniperOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SniperOrder_tokenMint_idx" ON "SniperOrder"("tokenMint");

-- CreateIndex
CREATE INDEX "SniperOrder_signature_idx" ON "SniperOrder"("signature");

-- CreateIndex
CREATE UNIQUE INDEX "SniperPosition_orderId_key" ON "SniperPosition"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SniperPosition_entrySignature_key" ON "SniperPosition"("entrySignature");

-- CreateIndex
CREATE UNIQUE INDEX "SniperPosition_exitSignature_key" ON "SniperPosition"("exitSignature");

-- CreateIndex
CREATE INDEX "SniperPosition_userId_status_idx" ON "SniperPosition"("userId", "status");

-- CreateIndex
CREATE INDEX "SniperPosition_tokenMint_status_idx" ON "SniperPosition"("tokenMint", "status");

-- CreateIndex
CREATE INDEX "SniperPosition_status_openedAt_idx" ON "SniperPosition"("status", "openedAt");

-- AddForeignKey
ALTER TABLE "SniperOrder" ADD CONSTRAINT "SniperOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SniperPosition" ADD CONSTRAINT "SniperPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
