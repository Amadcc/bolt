import { PublicKey } from "@solana/web3.js";
import { MPL_TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import { logger } from "../../utils/logger.js";
import { getSolanaConnection } from "../blockchain/solana.js";

export interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string;
}

interface CachedMetadata {
  value: TokenMetadata | null;
  timestamp: number;
}

const METADATA_PROGRAM = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);
const metadataCache = new Map<string, CachedMetadata>();
const METADATA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch token metadata (name/symbol/uri) via Metaplex metadata PDA.
 * Result is cached briefly to avoid redundant RPC calls.
 */
export async function fetchTokenMetadata(
  mint: string
): Promise<TokenMetadata | null> {
  const cached = metadataCache.get(mint);
  if (cached && Date.now() - cached.timestamp < METADATA_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const connection = await getSolanaConnection();
    const mintKey = new PublicKey(mint);

    const [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM.toBuffer(),
        mintKey.toBuffer(),
      ],
      METADATA_PROGRAM
    );

    const accountInfo = await connection.getAccountInfo(metadataPda);
    if (!accountInfo) {
      metadataCache.set(mint, { value: null, timestamp: Date.now() });
      return null;
    }

    const buffer = Buffer.from(accountInfo.data);
    const cursor = { offset: 1 + 32 + 32 }; // key + updateAuth + mint

    const name = readBorshString(buffer, cursor);
    const symbol = readBorshString(buffer, cursor);
    const uri = readBorshString(buffer, cursor);

    const metadata: TokenMetadata = {
      name,
      symbol,
      uri,
    };

    metadataCache.set(mint, { value: metadata, timestamp: Date.now() });
    return metadata;
  } catch (error) {
    logger.warn("Failed to fetch token metadata", {
      mint,
      error,
    });
    metadataCache.set(mint, { value: null, timestamp: Date.now() });
    return null;
  }
}

function readBorshString(
  buffer: Buffer,
  cursor: { offset: number }
): string {
  if (cursor.offset + 4 > buffer.length) {
    return "";
  }

  const length = buffer.readUInt32LE(cursor.offset);
  cursor.offset += 4;

  if (cursor.offset + length > buffer.length) {
    cursor.offset = buffer.length;
    return "";
  }

  const value = buffer.slice(cursor.offset, cursor.offset + length);
  cursor.offset += length;

  return value.toString("utf8").replace(/\0/g, "").trim();
}
