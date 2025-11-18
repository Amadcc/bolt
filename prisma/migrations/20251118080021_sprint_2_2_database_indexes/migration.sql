/*
  Warnings:

  - A unique constraint covering the columns `[userId,label]` on the table `Wallet` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `Wallet` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "SniperOrder_userId_status_createdAt_idx" ON "SniperOrder"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SniperPosition_userId_status_tokenMint_idx" ON "SniperPosition"("userId", "status", "tokenMint");

-- CreateIndex
CREATE INDEX "Wallet_userId_isPrimary_idx" ON "Wallet"("userId", "isPrimary");

-- CreateIndex
CREATE INDEX "Wallet_userId_lastUsedAt_idx" ON "Wallet"("userId", "lastUsedAt");

-- CreateIndex
CREATE INDEX "Wallet_userId_isActive_lastUsedAt_idx" ON "Wallet"("userId", "isActive", "lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_label_key" ON "Wallet"("userId", "label");
