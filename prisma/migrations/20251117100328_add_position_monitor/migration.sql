-- CreateTable
CREATE TABLE "PositionMonitor" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entryPrice" DECIMAL(20,10) NOT NULL,
    "currentPrice" DECIMAL(20,10),
    "lastPriceUpdate" TIMESTAMP(3),
    "takeProfitPrice" DECIMAL(20,10),
    "stopLossPrice" DECIMAL(20,10),
    "trailingStopLoss" BOOLEAN NOT NULL DEFAULT false,
    "highestPriceSeen" DECIMAL(20,10),
    "priceCheckCount" INTEGER NOT NULL DEFAULT 0,
    "exitAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PositionMonitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PositionMonitor_positionId_key" ON "PositionMonitor"("positionId");

-- CreateIndex
CREATE INDEX "PositionMonitor_status_lastCheckAt_idx" ON "PositionMonitor"("status", "lastCheckAt");

-- CreateIndex
CREATE INDEX "PositionMonitor_tokenMint_status_idx" ON "PositionMonitor"("tokenMint", "status");

-- CreateIndex
CREATE INDEX "PositionMonitor_userId_status_idx" ON "PositionMonitor"("userId", "status");

-- AddForeignKey
ALTER TABLE "PositionMonitor" ADD CONSTRAINT "PositionMonitor_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "SniperPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
