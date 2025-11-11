import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  ensureDevnetEnv,
  createDevnetConnection,
  ensureDevnetBalance,
} from "./helpers/devnet.js";

const devnetConfig = ensureDevnetEnv();
const connection = createDevnetConnection(devnetConfig);

describe("Devnet RPC smoke tests", () => {
  it(
    "connects to devnet RPC and fetches slot height",
    { timeout: 30000 },
    async () => {
      const slot = await connection.getSlot("confirmed");
      expect(slot).toBeGreaterThan(0);

      const version = await connection.getVersion();
      expect(version["solana-core"]).toBeDefined();
    }
  );

  it(
    "funds a disposable keypair via airdrop",
    { timeout: 60000 },
    async () => {
      const keypair = Keypair.generate();

      const lamports = await ensureDevnetBalance(
        connection,
        keypair.publicKey,
        devnetConfig.minAirdropLamports
      );

      expect(lamports).toBeGreaterThanOrEqual(
        devnetConfig.minAirdropLamports
      );
    }
  );
});
