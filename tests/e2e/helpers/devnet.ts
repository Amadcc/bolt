import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export interface DevnetEnvConfig {
  rpcUrl: string;
  network: "devnet";
  minAirdropLamports: number;
}

const DEFAULT_MIN_AIRDROP = Number(
  process.env.E2E_MIN_AIRDROP_LAMPORTS ?? 0.5 * LAMPORTS_PER_SOL
);

export function ensureDevnetEnv(): DevnetEnvConfig {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const network = process.env.SOLANA_NETWORK;

  if (!rpcUrl) {
    throw new Error(
      "SOLANA_RPC_URL is required for devnet E2E tests. See .env.e2e.example."
    );
  }

  if (network !== "devnet") {
    throw new Error(
      `E2E tests must run against devnet. Set SOLANA_NETWORK=devnet (currently: ${network ?? "undefined"}).`
    );
  }

  const minAirdropLamports =
    Number.isFinite(DEFAULT_MIN_AIRDROP) && DEFAULT_MIN_AIRDROP > 0
      ? Math.floor(DEFAULT_MIN_AIRDROP)
      : Math.floor(0.5 * LAMPORTS_PER_SOL);

  return {
    rpcUrl,
    network: "devnet",
    minAirdropLamports,
  };
}

export function createDevnetConnection(
  config: DevnetEnvConfig = ensureDevnetEnv()
): Connection {
  return new Connection(config.rpcUrl, {
    commitment: "confirmed",
  });
}

export async function confirmSignature(
  connection: Connection,
  signature: string
): Promise<void> {
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );
}

export async function ensureDevnetBalance(
  connection: Connection,
  publicKey: PublicKey,
  minLamports: number
): Promise<number> {
  const current = await connection.getBalance(publicKey, "confirmed");
  if (current >= minLamports) {
    return current;
  }

  const requestAmount = Math.max(minLamports - current, minLamports);
  const signature = await connection.requestAirdrop(publicKey, requestAmount);
  await confirmSignature(connection, signature);

  return connection.getBalance(publicKey, "confirmed");
}

export function shouldRunTradingTests(): boolean {
  return process.env.RUN_E2E_TRADING_TESTS === "true";
}
