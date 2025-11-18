-- CreateTable
CREATE TABLE "SniperFilterPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "preset" TEXT NOT NULL DEFAULT 'BALANCED',
    "customFilters" JSONB,
    "tokenOverrides" JSONB,
    "autoSniperEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SniperFilterPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SniperFilterPreference_userId_key" ON "SniperFilterPreference"("userId");

-- CreateIndex
CREATE INDEX "SniperFilterPreference_userId_idx" ON "SniperFilterPreference"("userId");

-- AddForeignKey
ALTER TABLE "SniperFilterPreference" ADD CONSTRAINT "SniperFilterPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
