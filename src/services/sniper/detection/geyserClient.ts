/**
 * Yellowstone gRPC client for real-time pool detection
 * Uses Geyser plugin for sub-second detection latency
 */

import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
} from "@triton-one/yellowstone-grpc";
import { EventEmitter } from "events";
import { logger } from "../../../utils/logger";
import { Result, Ok, Err } from "../../../types/common";
import type { DexType, PoolCreatedEvent } from "../../../types/sniper";
import {
  PUMPFUN_PROGRAM,
  PROGRAM_TO_DEX,
} from "./constants";
import bs58 from "bs58";

// ============================================================================
// Types
// ============================================================================

export interface GeyserConfig {
  endpoint: string;
  token: string;
  commitment: "processed" | "confirmed";
  reconnectDelayMs: number;
  maxReconnectAttempts: number;
}

export interface GeyserClientEvents {
  "pool:created": (event: PoolCreatedEvent) => void;
  connected: () => void;
  disconnected: (error?: Error) => void;
  error: (error: Error) => void;
}

// ============================================================================
// GeyserClient
// ============================================================================

export class GeyserClient extends EventEmitter {
  private client: Client | null = null;
  private stream: AsyncGenerator<SubscribeUpdate> | null = null;
  private isRunning = false;
  private reconnectAttempts = 0;
  private pingInterval: Timer | null = null;

  constructor(private config: GeyserConfig) {
    super();
  }

  /**
   * Connect to Yellowstone gRPC and start streaming
   */
  async connect(): Promise<Result<void, Error>> {
    if (this.isRunning) {
      return Err(new Error("GeyserClient already running"));
    }

    try {
      logger.info("Connecting to Yellowstone gRPC", {
        endpoint: this.config.endpoint,
        commitment: this.config.commitment,
      });

      // Create gRPC client
      this.client = new Client(this.config.endpoint, this.config.token, {});

      // Subscribe to transactions
      const stream = await this.client.subscribe();
      this.stream = stream as unknown as AsyncGenerator<SubscribeUpdate>;

      // Send subscription request
      const request = this.buildSubscribeRequest();

      // Get the writable stream
      const writeStream = stream as unknown as { write: (req: SubscribeRequest) => Promise<void> };
      await writeStream.write(request);

      this.isRunning = true;
      this.reconnectAttempts = 0;
      this.emit("connected");

      logger.info("Connected to Yellowstone gRPC");

      // Start processing messages
      this.processStream().catch((error) => {
        logger.error("Stream processing error", { error: error.message });
        this.handleDisconnect(error);
      });

      // Start ping interval to keep connection alive
      this.startPingInterval();

      return Ok(undefined);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to connect to Yellowstone gRPC", {
        error: err.message,
      });
      return Err(err);
    }
  }

  /**
   * Disconnect from Yellowstone gRPC
   */
  async disconnect(): Promise<void> {
    this.isRunning = false;

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.stream) {
      try {
        await this.stream.return(undefined);
      } catch {
        // Ignore stream close errors
      }
      this.stream = null;
    }

    this.client = null;
    this.emit("disconnected");
    logger.info("Disconnected from Yellowstone gRPC");
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.isRunning && this.client !== null;
  }

  /**
   * Build subscription request for all supported DEXs
   */
  private buildSubscribeRequest(): SubscribeRequest {
    const commitment =
      this.config.commitment === "processed"
        ? CommitmentLevel.PROCESSED
        : CommitmentLevel.CONFIRMED;

    return {
      accounts: {},
      slots: {},
      transactions: {
        pumpfun: {
          vote: false,
          failed: false,
          accountInclude: [PUMPFUN_PROGRAM.toBase58()],
          accountExclude: [],
          accountRequired: [],
        },
        // Note: Chainstack may block wide filters
        // Enable these when using Helius/Triton
        // raydiumV4: {
        //   vote: false,
        //   failed: false,
        //   accountInclude: [RAYDIUM_AMM_V4.toBase58()],
        //   accountExclude: [],
        //   accountRequired: [],
        // },
        // raydiumClmm: {
        //   vote: false,
        //   failed: false,
        //   accountInclude: [RAYDIUM_CLMM.toBase58()],
        //   accountExclude: [],
        //   accountRequired: [],
        // },
        // meteora: {
        //   vote: false,
        //   failed: false,
        //   accountInclude: [METEORA_DLMM.toBase58()],
        //   accountExclude: [],
        //   accountRequired: [],
        // },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment,
      accountsDataSlice: [],
      ping: undefined,
    };
  }

  /**
   * Process incoming stream messages
   */
  private async processStream(): Promise<void> {
    if (!this.stream) return;

    for await (const message of this.stream) {
      if (!this.isRunning) break;

      try {
        if (message.transaction) {
          const event = this.parseTransaction(message.transaction);
          if (event) {
            this.emit("pool:created", event);
          }
        } else if (message.pong) {
          // Pong received, connection is alive
        }
      } catch (error) {
        logger.error("Error processing message", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Parse transaction to extract pool creation event
   */
  private parseTransaction(tx: SubscribeUpdate["transaction"]): PoolCreatedEvent | null {
    if (!tx?.transaction) return null;

    const { transaction, slot } = tx;
    const txData = transaction.transaction;
    const message = txData?.message;
    const sig = transaction.signature;

    if (!message || !sig) return null;

    // Get account keys
    const accountKeys = message.accountKeys?.map((key) =>
      bs58.encode(Buffer.from(key))
    ) || [];

    // Find which program was called
    const instructions = message.instructions || [];

    for (const ix of instructions) {
      const programId = accountKeys[ix.programIdIndex];
      const dex = PROGRAM_TO_DEX[programId] as DexType | undefined;

      if (!dex) continue;

      // Parse based on DEX type
      const event = this.parsePoolCreation(
        dex,
        ix,
        accountKeys,
        Number(slot),
        bs58.encode(Buffer.from(sig))
      );

      if (event) return event;
    }

    return null;
  }

  /**
   * Parse pool creation instruction for specific DEX
   */
  private parsePoolCreation(
    dex: DexType,
    ix: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array },
    accountKeys: string[],
    slot: number,
    signature: string
  ): PoolCreatedEvent | null {
    const accounts = Array.from(ix.accounts).map((i) => accountKeys[i]);
    const data = Buffer.from(ix.data);

    switch (dex) {
      case "pumpfun":
        return this.parsePumpfunCreate(accounts, data, slot, signature);
      case "raydium_v4":
        return this.parseRaydiumV4Initialize(accounts, data, slot, signature);
      default:
        return null;
    }
  }

  /**
   * Parse Pump.fun create instruction
   * Instruction discriminator: first 8 bytes
   */
  private parsePumpfunCreate(
    accounts: string[],
    data: Buffer,
    slot: number,
    signature: string
  ): PoolCreatedEvent | null {
    // Pump.fun create discriminator (anchor): 0x181ec828051c0777
    const CREATE_DISCRIMINATOR = Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);

    if (data.length < 8) return null;

    const discriminator = data.subarray(0, 8);
    if (!discriminator.equals(CREATE_DISCRIMINATOR)) return null;

    // Account layout for pump.fun create:
    // 0: mint
    // 1: mintAuthority
    // 2: bondingCurve
    // 3: associatedBondingCurve
    // 4: global
    // 5: mplTokenMetadata
    // 6: metadata
    // 7: user (creator)
    // ...

    if (accounts.length < 8) return null;

    const {
      asTokenMintUnsafe,
      asSolanaAddressUnsafe,
      asTransactionSignatureUnsafe,
      asLamports,
    } = require("../../../types/common");
    const { SOL_MINT } = require("./constants");

    try {
      return {
        signature: asTransactionSignatureUnsafe(signature),
        slot,
        timestamp: Date.now(),
        dex: "pumpfun",
        poolAddress: asSolanaAddressUnsafe(accounts[2]), // bondingCurve (PDA)
        baseMint: asTokenMintUnsafe(accounts[0]), // mint
        quoteMint: asTokenMintUnsafe(SOL_MINT.toBase58()), // Always SOL for pump.fun
        initialLiquidity: asLamports(0n), // Will be fetched later
        creator: asSolanaAddressUnsafe(accounts[7]), // user
      };
    } catch (error) {
      logger.warn("Failed to parse pump.fun create", {
        error: error instanceof Error ? error.message : String(error),
        accounts,
      });
      return null;
    }
  }

  /**
   * Parse Raydium V4 initialize2 instruction
   */
  private parseRaydiumV4Initialize(
    accounts: string[],
    data: Buffer,
    slot: number,
    signature: string
  ): PoolCreatedEvent | null {
    // Raydium initialize2 discriminator: 0x01 (first byte)
    if (data.length < 1 || data[0] !== 1) return null;

    // Account layout for initialize2:
    // 4: ammId (pool)
    // 8: coinMint
    // 9: pcMint (quote)
    // 17: userWallet (creator)

    if (accounts.length < 18) return null;

    const {
      asTokenMintUnsafe,
      asSolanaAddressUnsafe,
      asTransactionSignatureUnsafe,
      asLamports,
    } = require("../../../types/common");

    try {
      return {
        signature: asTransactionSignatureUnsafe(signature),
        slot,
        timestamp: Date.now(),
        dex: "raydium_v4",
        poolAddress: asSolanaAddressUnsafe(accounts[4]), // ammId (PDA)
        baseMint: asTokenMintUnsafe(accounts[8]), // coinMint
        quoteMint: asTokenMintUnsafe(accounts[9]), // pcMint
        initialLiquidity: asLamports(0n), // Will be fetched later
        creator: asSolanaAddressUnsafe(accounts[17]), // userWallet
      };
    } catch (error) {
      logger.warn("Failed to parse Raydium V4 initialize2", {
        error: error instanceof Error ? error.message : String(error),
        accounts,
      });
      return null;
    }
  }

  /**
   * Handle disconnection with auto-reconnect
   */
  private async handleDisconnect(error?: Error): Promise<void> {
    if (!this.isRunning) return;

    this.emit("disconnected", error);

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error("Max reconnect attempts reached", {
        attempts: this.reconnectAttempts,
      });
      this.emit("error", new Error("Max reconnect attempts reached"));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

    logger.info("Reconnecting to Yellowstone gRPC", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    await new Promise((resolve) => setTimeout(resolve, delay));

    // Reset state
    this.stream = null;
    this.client = null;

    // Reconnect
    const result = await this.connect();
    if (!result.success) {
      await this.handleDisconnect(result.error);
    }
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    this.pingInterval = setInterval(async () => {
      if (!this.stream || !this.isRunning) return;

      try {
        const writeStream = this.stream as unknown as {
          write: (req: Partial<SubscribeRequest>) => Promise<void>
        };
        await writeStream.write({ ping: { id: 1 } });
      } catch (error) {
        logger.warn("Ping failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 30000); // Ping every 30 seconds
  }
}

// ============================================================================
// Factory function
// ============================================================================

export function createGeyserClient(config?: Partial<GeyserConfig>): GeyserClient {
  const fullConfig: GeyserConfig = {
    endpoint: process.env.GEYSER_ENDPOINT || "https://yellowstone-solana-mainnet.core.chainstack.com",
    token: process.env.GEYSER_TOKEN || "",
    commitment: "processed", // Use PROCESSED for faster detection (like Chainstack Python example)
    reconnectDelayMs: 1000,
    maxReconnectAttempts: 10,
    ...config,
  };

  return new GeyserClient(fullConfig);
}
