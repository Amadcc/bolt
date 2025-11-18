-- CreateTable
CREATE TABLE "CopyTradeProtectionSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "privacyMode" TEXT NOT NULL DEFAULT 'OFF',
    "timingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "baseDelayMs" INTEGER NOT NULL DEFAULT 0,
    "jitterPercent" INTEGER NOT NULL DEFAULT 0,
    "minDelayMs" INTEGER NOT NULL DEFAULT 0,
    "maxDelayMs" INTEGER NOT NULL DEFAULT 0,
    "feePatternStrategy" TEXT NOT NULL DEFAULT 'FIXED',
    "allowedFeeModes" TEXT[] DEFAULT ARRAY['MEDIUM']::TEXT[],
    "addMicroJitter" BOOLEAN NOT NULL DEFAULT false,
    "microJitterPercent" INTEGER NOT NULL DEFAULT 0,
    "walletRotationStrategy" TEXT NOT NULL DEFAULT 'ROUND_ROBIN',
    "freshThreshold" INTEGER,
    "autoFundFreshWallets" BOOLEAN NOT NULL DEFAULT false,
    "freshWalletFunding" DECIMAL(20,0) NOT NULL DEFAULT 0,
    "walletIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "forceJitoRouting" BOOLEAN NOT NULL DEFAULT false,
    "useAntiSandwich" BOOLEAN NOT NULL DEFAULT false,
    "minTipLamports" DECIMAL(20,0) NOT NULL DEFAULT 10000,
    "maxTipLamports" DECIMAL(20,0) NOT NULL DEFAULT 50000,
    "randomizeTips" BOOLEAN NOT NULL DEFAULT false,
    "obfuscationPattern" TEXT NOT NULL DEFAULT 'NONE',
    "obfuscationStrength" INTEGER NOT NULL DEFAULT 0,
    "addRandomMemos" BOOLEAN NOT NULL DEFAULT false,
    "maxMemoLength" INTEGER NOT NULL DEFAULT 0,
    "addDummyInstructions" BOOLEAN NOT NULL DEFAULT false,
    "maxDummyInstructions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyTradeProtectionSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CopyTradeProtectionSettings_userId_key" ON "CopyTradeProtectionSettings"("userId");

-- CreateIndex
CREATE INDEX "CopyTradeProtectionSettings_userId_idx" ON "CopyTradeProtectionSettings"("userId");

-- CreateIndex
CREATE INDEX "CopyTradeProtectionSettings_privacyMode_idx" ON "CopyTradeProtectionSettings"("privacyMode");

-- AddForeignKey
ALTER TABLE "CopyTradeProtectionSettings" ADD CONSTRAINT "CopyTradeProtectionSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
