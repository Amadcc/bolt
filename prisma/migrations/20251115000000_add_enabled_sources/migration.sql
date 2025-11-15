-- AlterTable
ALTER TABLE "SnipeConfig" ADD COLUMN IF NOT EXISTS "enabledSources" TEXT[] DEFAULT ARRAY['pumpfun', 'raydium', 'orca', 'meteora']::TEXT[];

-- Update existing rows to have the default value
UPDATE "SnipeConfig" SET "enabledSources" = ARRAY['pumpfun', 'raydium', 'orca', 'meteora']::TEXT[] WHERE "enabledSources" IS NULL;
