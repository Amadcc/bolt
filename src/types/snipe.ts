import type { SnipeConfig, SnipeExecution } from "@prisma/client";
import type { Lamports, Result, TokenMint } from "./common.js";

export type DiscoverySource = "pumpfun" | "jupiter" | "raydium" | "orca";

export interface NewTokenEvent {
  source: DiscoverySource;
  mint: TokenMint;
  name: string;
  symbol: string;
  creator?: string;
  liquidityLamports: Lamports;
  marketCapUsd?: number;
  tx: string;
  timestamp: Date;
}

export interface FilterContext {
  config: SnipeConfig;
  event: NewTokenEvent;
}

export interface FilterResult {
  passed: boolean;
  reason?: string;
}

export interface AnalysisResult {
  honeypotScore: number;
  liquidityLamports?: Lamports;
  marketCapUsd?: number;
  holderCount?: number;
  top10HolderPercent?: number;
  creatorHolderPercent?: number;
}

export interface ExecutionResult {
  success: boolean;
  signature?: string;
  priorityFeeLamports?: Lamports;
  outputAmountTokens?: bigint;
  error?: string;
}

export interface SnipeTask {
  execution: SnipeExecution;
  analysis?: AnalysisResult;
  filterReason?: string;
}

export interface AutomationLease {
  userId: string;
  walletId: string;
  expiresAt: Date;
}

export type SnipePipelineResult = Result<ExecutionResult, string>;
