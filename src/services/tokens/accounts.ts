import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../../utils/logger.js";
import { getSolanaConnection } from "../blockchain/solana.js";

export interface TokenAccountBalance {
  mint: string;
  amount: number;
  rawAmount: bigint;
  decimals: number;
  uiAmountString: string;
}

/**
 * Fetch parsed SPL token accounts for a wallet owner.
 */
export async function getTokenAccountsForOwner(
  owner: PublicKey,
  connection?: Connection
): Promise<TokenAccountBalance[]> {
  try {
    const rpc = connection ?? (await getSolanaConnection());

    const response = await rpc.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    });

    return response.value
      .map((account) => {
        const parsed = account.account.data.parsed?.info;
        const tokenAmount = parsed?.tokenAmount;

        if (!parsed || !tokenAmount) {
          return null;
        }

        const amount = Number.parseFloat(tokenAmount.uiAmountString ?? "0");

        return {
          mint: parsed.mint as string,
          amount,
          rawAmount: BigInt(tokenAmount.amount),
          decimals: tokenAmount.decimals as number,
          uiAmountString: tokenAmount.uiAmountString as string,
        };
      })
      .filter((value): value is TokenAccountBalance => Boolean(value));
  } catch (error) {
    logger.error("Failed to fetch token accounts", {
      owner: owner.toBase58(),
      error,
    });
    return [];
  }
}
