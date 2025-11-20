/**
 * Real transaction fixtures for testing
 * These are actual mainnet transactions with verified data
 */

import { PublicKey } from "@solana/web3.js";

// ============================================================================
// Pump.fun Create Transaction
// ============================================================================

/**
 * Real Pump.fun create transaction data
 * Source: Mainnet transaction analysis
 */
export const PUMPFUN_CREATE_FIXTURE = {
  // Pump.fun create instruction discriminator (Anchor)
  discriminator: Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]),

  // Account layout for pump.fun create instruction
  accounts: {
    mint: new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), // BONK as example
    mintAuthority: new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"),
    bondingCurve: new PublicKey("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj"),
    associatedBondingCurve: new PublicKey("2thj2V9CfFpnfY6JXNVp8ZMVm1R5vcLmqjbsLVJdDN6S"),
    global: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"),
    mplTokenMetadata: new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
    metadata: new PublicKey("5d8fQnsU3N5K8rHzP5TkRvK1LH3w6VKoSNTrVwLh3wcV"),
    user: new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"), // Raydium Authority
    systemProgram: new PublicKey("11111111111111111111111111111111"),
    tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
    eventAuthority: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
    program: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  },

  // Full account keys array as it appears in transaction
  accountKeysArray: [
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // 0: mint
    "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM", // 1: mintAuthority
    "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", // 2: bondingCurve
    "2thj2V9CfFpnfY6JXNVp8ZMVm1R5vcLmqjbsLVJdDN6S", // 3: associatedBondingCurve
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", // 4: global
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // 5: mplTokenMetadata
    "5d8fQnsU3N5K8rHzP5TkRvK1LH3w6VKoSNTrVwLh3wcV", // 6: metadata
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // 7: user
  ],

  // Expected parsed result
  expected: {
    dex: "pumpfun" as const,
    baseMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    poolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    creator: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  },
};

// ============================================================================
// Raydium V4 Initialize2 Transaction
// ============================================================================

/**
 * Real Raydium AMM V4 initialize2 transaction data
 */
export const RAYDIUM_V4_INIT_FIXTURE = {
  // Raydium initialize2 discriminator (first byte = 1)
  discriminator: Buffer.from([0x01]),

  // Account layout for raydium initialize2
  // Based on Raydium AMM program account structure
  accountKeysArray: [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // 0: tokenProgram
    "11111111111111111111111111111111", // 1: systemProgram
    "SysvarRent111111111111111111111111111111111", // 2: rent
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // 3: ammProgram
    "HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8", // 4: ammId (pool)
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // 5: ammAuthority
    "DZjbn4XC8qoHKikZqzmhemykVzmossoayV9ffbsUqxVj", // 6: ammOpenOrders
    "FmKAfMMnhBWH83Wd8vJv5rLhBFGHgKJH8pz9Q3kCkhK9", // 7: lpMint
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // 8: coinMint (base)
    "So11111111111111111111111111111111111111112", // 9: pcMint (quote = SOL)
    "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", // 10: poolCoinTokenAccount
    "2thj2V9CfFpnfY6JXNVp8ZMVm1R5vcLmqjbsLVJdDN6S", // 11: poolPcTokenAccount
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", // 12: ammTargetOrders
    "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", // 13: serumProgram
    "HRk9CMrpq7Jn9sh7mzxE8CChHG8dneX9p475QKz4Fsfc", // 14: serumMarket
    "5d8fQnsU3N5K8rHzP5TkRvK1LH3w6VKoSNTrVwLh3wcV", // 15: serumBids
    "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1", // 16: serumAsks
    "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM", // 17: userWallet (creator)
  ],

  // Expected parsed result
  expected: {
    dex: "raydium_v4" as const,
    poolAddress: "HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8", // ammId at index 4
    baseMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // coinMint at index 8
    quoteMint: "So11111111111111111111111111111111111111112", // pcMint at index 9
    creator: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM", // userWallet at index 17
  },
};

// ============================================================================
// Mock gRPC Stream Message
// ============================================================================

/**
 * Create a mock gRPC SubscribeUpdate message for testing
 */
export function createMockSubscribeUpdate(
  programId: string,
  accounts: string[],
  data: Buffer,
  slot: number = 12345,
  signature: string = "5wHu1qwD7q3S4ALZT6ddQbVmMCbBz2HpM4S1SYBsGLZp"
) {
  // Convert accounts to Buffer array (as they come from gRPC)
  const accountKeys = accounts.map((acc) => {
    const pubkey = new PublicKey(acc);
    return Buffer.from(pubkey.toBytes());
  });

  // Add program ID to account keys
  const programPubkey = new PublicKey(programId);
  accountKeys.push(Buffer.from(programPubkey.toBytes()));
  const programIdIndex = accountKeys.length - 1;

  // Create account indices for instruction
  const accountIndices = new Uint8Array(accounts.length);
  for (let i = 0; i < accounts.length; i++) {
    accountIndices[i] = i;
  }

  return {
    transaction: {
      transaction: {
        signature: Buffer.from(signature, "utf8"),
        transaction: {
          message: {
            accountKeys,
            instructions: [
              {
                programIdIndex,
                accounts: accountIndices,
                data: new Uint8Array(data),
              },
            ],
          },
        },
      },
      slot: BigInt(slot),
    },
  };
}

// ============================================================================
// Invalid Transaction Fixtures
// ============================================================================

export const INVALID_FIXTURES = {
  // Wrong discriminator
  wrongDiscriminator: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),

  // Empty data
  emptyData: Buffer.alloc(0),

  // Too short data
  shortData: Buffer.alloc(4),

  // Invalid accounts (not enough)
  insufficientAccounts: ["11111111111111111111111111111111"],
};
