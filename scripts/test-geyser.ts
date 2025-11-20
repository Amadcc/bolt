/**
 * Test script for Chainstack Yellowstone gRPC connection
 * Based on working Python code from Chainstack support
 */

import Client, {
  CommitmentLevel,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";

const ENDPOINT = "https://yellowstone-solana-mainnet.core.chainstack.com";
const X_TOKEN = process.env.GEYSER_TOKEN || "d2e04d5bcba4719c5bf5f977b886a5be";
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

async function main() {
  console.log("🔌 Connecting to Chainstack Yellowstone gRPC...");
  console.log(`   Endpoint: ${ENDPOINT}`);
  console.log(`   Token: ${X_TOKEN.slice(0, 8)}...`);

  try {
    // Create client
    const client = new Client(ENDPOINT, X_TOKEN, {});

    // Test 1: Get version
    console.log("\n📋 Test 1: GetVersion");
    const version = await client.getVersion();
    console.log(`   Version: ${version.version}`);

    // Test 2: Subscribe to transactions
    console.log("\n📡 Test 2: Subscribe to Pump.fun transactions");
    console.log("   Waiting for transactions (max 60 seconds)...\n");

    const stream = await client.subscribe();

    // Build subscription request - matching Python code exactly
    const request: SubscribeRequest = {
      accounts: {},
      slots: {},
      transactions: {
        pumpfun_txs: {
          vote: false,
          failed: false,
          accountInclude: [PUMPFUN_PROGRAM_ID],
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.PROCESSED, // Key: use PROCESSED like Python
      accountsDataSlice: [],
      ping: undefined,
    };

    // Send subscription
    const writeStream = stream as unknown as {
      write: (req: SubscribeRequest) => Promise<void>;
    };
    await writeStream.write(request);
    console.log("   ✅ Subscription sent");

    // Read responses
    let txCount = 0;
    const maxTxs = 5;
    const timeout = 60000; // 60 seconds

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout after 60 seconds")), timeout);
    });

    const streamPromise = (async () => {
      const asyncStream = stream as AsyncIterable<any>;
      for await (const update of asyncStream) {
        // Handle pong
        if (update.pong) {
          console.log("   📍 Pong received");
          continue;
        }

        // Handle transaction
        if (update.transaction) {
          const tx = update.transaction;
          const sig = tx.transaction?.signature;
          const sigB58 = sig ? bs58.encode(Buffer.from(sig)) : "unknown";

          console.log(
            `   [TX ${txCount + 1}] slot=${tx.slot} sig=${sigB58.slice(0, 20)}...`
          );

          txCount++;
          if (txCount >= maxTxs) {
            console.log(`\n   ✅ Received ${maxTxs} transactions successfully!`);
            break;
          }
        }

        // Handle block meta
        if (update.blockMeta) {
          console.log(`   [BLOCK] slot=${update.blockMeta.slot}`);
        }
      }
    })();

    await Promise.race([streamPromise, timeoutPromise]);

    if (txCount === 0) {
      console.log("\n   ⚠️  No transactions received within timeout");
      console.log("   This might indicate a subscription issue");
    }

    // Cleanup
    try {
      const returnStream = stream as unknown as {
        return: (value?: any) => Promise<any>;
      };
      await returnStream.return(undefined);
    } catch {
      // Ignore close errors
    }

    console.log("\n✅ Test completed!");
  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
