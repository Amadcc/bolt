# Building Crypto Token Sniper Bots: Technical Architecture and Implementation

The competitive crypto sniper bot landscape is dominated by Trojan, Banana Gun, Maestro, and BONKbot, each taking distinct architectural approaches to solve the core challenge: detecting and executing token purchases faster than competitors while avoiding scams. This report deconstructs their technical implementations to provide actionable insights for developers.

## Token detection: The foundation of speed

**EVM chains use WebSocket mempool monitoring while Solana requires different approaches entirely.** The architectural divergence stems from fundamental blockchain differences—Ethereum's public mempool versus Solana's leader-based transaction forwarding.

### Ethereum and BSC implementation

The fastest bots establish persistent WebSocket connections using ethers.js v6 (not the deprecated web3.js). Banana Gun invests $3.6 million annually in custom RPC infrastructure for this exact purpose. The critical method is `eth_subscribe('pendingTransactions')`, which provides real-time pending transaction hashes before block inclusion.

```javascript
const provider = new ethers.WebSocketProvider("wss://YOUR-ENDPOINT");
provider.on("pending", async (txHash) => {
  const tx = await provider.getTransaction(txHash);
  if (tx && tx.to === UNISWAP_ROUTER && tx.data.includes("0x414bf389")) {
    // Detected addLiquidity transaction
    const decoded = interface.decodeFunctionData("exactInputSingle", tx.data);
    // Execute snipe logic
  }
});
```

**Function signature identification is crucial.** The first 4 bytes of transaction data reveal the function being called: `0x414bf389` indicates a Uniswap swap, while addLiquidity functions signal new pool creation. Maestro monitors factory contracts for `PairCreated` events across 30+ DEXs simultaneously.

Banana Gun's competitive advantage comes from its exclusive orderflow arrangement with Titan Builder, routing sniper bundles privately. This architectural moat means even if competitors replicate features, they cannot match execution speed without similar validator relationships. The blind bribing mechanism lets users submit hidden ETH tips (0.1-0.5+ ETH for competitive launches), creating strategic unpredictability that public gas markets cannot provide.

### Solana's fundamentally different approach

**Solana has no traditional mempool.** Transactions route directly to the current leader validator via TPU (Transaction Processing Unit) forwarding, with 400ms leader rotation. This architectural reality forces different detection strategies.

The superior method uses **Geyser plugins with Yellowstone gRPC**—validator plugin mechanisms streaming blockchain data before public RPC exposure. Helius, Chainstack, and Triton One offer Geyser-as-a-Service. Trojan and BONKbot likely use premium Geyser subscriptions for their sub-2-second execution speeds.

For developers building from scratch, the practical approach uses Solana's WebSocket RPC methods:

```typescript
connection.onLogs(
  RAYDIUM_PROGRAM_ID, // "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
  async (logs) => {
    if (logs.some((log) => log.includes("initialize"))) {
      await fetchRaydiumMints(logs.signature, connection);
    }
  },
  "confirmed" // Not "finalized" - speed matters
);
```

**The critical accounts are 8 and 9 in Raydium transactions**—these contain the new token mint addresses. Monitoring `programSubscribe` for Raydium AMM V4 and Jupiter aggregator captures new liquidity pools. BONKbot's limitation here is notable: it only supports tokens already listed on major DEXs, lacking the dedicated sniper mode that Trojan offers.

### Maestro's 500+ channel scraper advantage

Maestro implements signal aggregation beyond blockchain monitoring. Their standalone "Maestro Scraper" desktop application monitors any Telegram group, channel, bot, or DM using the Telegram API. When influencers post contract addresses, the bot extracts and validates them instantly. This social layer detection provides 5-30 minute advantages over Jupiter aggregation indexing for new Raydium CLMM pools.

## Execution speed: The millisecond war

**Private RPC nodes are non-negotiable for competitive bots.** Public endpoints like Infura introduce 200-500ms latency that kills sniper profitability. QuickNode markets "8x faster" speeds; Banana Gun's $3.6M infrastructure investment validates this necessity.

### Block 0 bundling architecture

Banana Gun achieves 88-92% Block 0 win rates through bundled transaction submission. Multiple user transactions group into a single package forwarded directly to block builders (validators). The "First Bundle or Fail" mode ensures either Block 0 inclusion or automatic transaction reversion—preventing wasteful gas spending in Block 1 or later.

**The technical mechanism:**

1. Users configure snipe with ETH bribe amount (not GWEI—absolute ETH)
2. Bot aggregates all users sniping the same token
3. Bundle submission to Titan Builder (Banana Gun's exclusive partner)
4. Internal bundle ordering by bribe size
5. Backup transactions sent independently if bundle fails

Maestro implements similar bundle-based Block 0 sniping but without exclusive builder relationships. Their cooperative-competitive model pools Maestro users together, sharing execution costs while competing internally by gas price.

### Jito MEV for Solana speed optimization

Trojan and BONKbot both integrate Jito's MEV infrastructure, but with different implementations. Jito operates an off-chain Block Engine running auctions for transaction bundles (max 5 transactions per bundle, atomic execution). Validators running Jito-Solana clients prioritize these bundles, distributing MEV rewards to JitoSOL stakers.

**Dual-mode architecture provides speed/security tradeoffs:**

- **MEV Turbo**: Prioritizes speed, uses Jito when fastest but falls back to regular RPC if quicker. Suitable for smaller trades where sandwich attack risk is minimal.
- **MEV Secure**: Guarantees protection by forcing Jito routing even when slower. Required for high-value positions.

Technical implementation requires gRPC or JSON-RPC bundle submission:

```rust
let bundle = Bundle {
    transactions: vec![swap_tx, tip_tx],
    uuid: Uuid::new_v4().to_string(),
};
client.send_bundle(&bundle).await?;
```

**Minimum tip is 1,000 lamports**, but competitive launches require 10,000+ lamports. The `jitodontfront111111111111111111111111111111` account can be included in instructions to prevent sandwiching—a unique Solana feature.

### BOLT technology remains proprietary

Trojan's sub-2-second BOLT execution engine is closed-source. Documentation reveals priority fee optimization (20% priority fee / 80% broadcast tip split recommended) and multi-provider redundancy (Jito, NextBlock, Temporal) but not the underlying algorithms. The 7 backup bot infrastructure ensures stability during Solana congestion when single-instance bots fail. BOLT PRO (for wallets with 50+ SOL) promises "almost never fail or timeout" with less than 2 seconds average—suggesting transaction batching, pre-calculated paths, and direct validator connections.

### Priority fee mathematics

**Dynamic gas management separates winners from losers.** Maestro implements smart gas boost with temporary 1.2x-2x multipliers during competitive entries. The mempool monitoring detects target transaction gas prices, then submits 5-10 GWEI higher to secure frontrunning position.

For Solana, compute budget instructions with priority fees replace traditional gas:

```javascript
const computeBudgetIx = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: priorityFee,
});
transaction.add(computeBudgetIx);
```

Trojan's "Fast Mode" (0.0015 SOL) versus "Turbo Mode" (0.0075 SOL) presets simplify this for users, but sophisticated bots implement real-time fee market analysis, adjusting dynamically based on network congestion and launch competitiveness.

## Honeypot and rug detection: The defensive layer

**No bot implements perfect honeypot detection—they combine multiple imperfect methods.** The most sophisticated approach uses API services, simulation, and bytecode analysis in parallel.

### GoPlus Security API dominates

GoPlus provides free, real-time security detection across 30+ chains. The Token Security API checks for:

- Mint authority status (revoked or active)
- Freeze authority status
- Hidden ownership mechanisms
- Proxy contracts and upgrade functions
- Blacklist/whitelist functions
- Buy/sell tax percentages
- Liquidity lock verification (UniCrypt, Team Finance, PinkLock, DxLock)

Integration is straightforward:

```javascript
const response = await fetch(
  `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`
);
const data = await response.json();
const isHoneypot = data.result[tokenAddress].is_honeypot === "1";
```

**Available SDKs for Go, Java, Node.js, Python, and PHP** make integration trivial. Maestro, Banana Gun, and most competitors use GoPlus as their primary detection layer.

### Honeypot.is simulation approach

Honeypot.is performs the critical test: buy and sell transaction simulation. If the sell reverts while buy succeeds, it's definitionally a honeypot. Banana Gun's "Banana Simulator" implements this same concept.

```typescript
await honeypotis
  .honeypotScan(tokenAddress, routerAddress, pairAddress, chainId)
  .then((result) => {
    if (result.IsHoneypot) {
      console.log(`Honeypot detected: ${result.Error}`);
    }
  });
```

**The limitation: private transactions bypass simulation.** If developers submit the rug pull through Flashbots or similar private relays, mempool-based detection fails. This explains Maestro's 85% (not 100%) anti-rug success rate.

### Trojan's filter-based approach

Trojan doesn't integrate traditional honeypot APIs. Instead, their Auto Sniper implements configurable filters:

**Authority checks:**

- Mint Authority Revoked: Filter for tokens where developers cannot mint additional supply
- Freeze Authority Revoked: Avoid tokens where developers can freeze transactions

**Developer holdings analysis:**

- Max Dev Holding %: Prevent sniping tokens where dev holds too much supply (common rug indicator)
- Min Dev Holding %: Ensure developers have "skin in the game"

**Liquidity and social verification:**

- Min/Max liquidity range settings
- Pool supply percentage checks
- Social presence requirements (Twitter, website, Telegram)

This deterministic approach is faster than API calls but less comprehensive. The documentation explicitly recommends using external honeypot checkers before trading—acknowledging the limitation.

### Maestro's patented anti-rug technology

**Maestro's standout feature: real-time rug pull frontrunning.** The system continuously scans mempool (ETH/BSC only) for malicious pending transactions:

- Liquidity removal (removeLiquidity calls)
- Blacklist additions
- Tax increase functions (>50% hikes)
- Trade disable functions
- Ownership transfers

When detected, Maestro automatically submits a sell transaction with gas set to `max(Rug Gas + 5, User Sell Gas)`, attempting to frontrun the rug pull. The 85% success rate indicates this works most of the time, but private transactions and extremely fast rug executions still succeed.

**This only works on chains with public mempools**—a fundamental limitation preventing Solana implementation.

### Contract simulation with callStatic

The most reliable developer-implemented method uses ethers.js `callStatic` for transaction simulation without execution:

```javascript
// Simulate buy
const router = new ethers.Contract(routerAddress, routerABI, provider);
const buyAmountOut = await router.callStatic.swapExactETHForTokens(
  amountOutMin,
  [WETH, tokenAddress],
  wallet.address,
  deadline,
  { value: ethAmount }
);

// Simulate sell
try {
  const sellAmountOut = await router.callStatic.swapExactTokensForETH(
    tokenAmount,
    amountOutMin,
    [tokenAddress, WETH],
    wallet.address,
    deadline
  );
  console.log("Sell simulation passed - not a honeypot");
} catch (error) {
  console.log("Honeypot detected:", error.message);
}
```

**Tax calculation from simulation** provides exact buy/sell percentages:

```javascript
const expectedTokens = await router.getAmountsOut(ethAmount, [WETH, token]);
const actualTokens = await simulateBuy(ethAmount);
const buyTax = ((expectedTokens - actualTokens) / expectedTokens) * 100;
```

Red flags: Buy tax >10%, sell tax >10%, combined >15-20%, or taxes that change post-launch.

### Token Sniffer's bytecode analysis

Token Sniffer (owned by Solidus Labs) analyzes both source code and bytecode against 10,000+ scam patterns. The service monitors 30,000+ new contracts daily, flagging 50-75% as scams. **Key advantage: detects patterns in unverified contracts** where source code is unavailable.

Academic research from USENIX Security 2019 identified 8 honeypot techniques in bytecode:

1. Balance Disorder (EVM-level exploit)
2. Type Deduction Overflow
3. Uninitialised Struct
4. Inheritance Disorder
5. Skip Empty String Literal
6. Hidden State Update
7. Hidden Transfer (delegatecall manipulation)
8. Straw Man Contract (different code than shown on Etherscan)

The HoneyBadger tool uses symbolic execution on bytecode, constructing control flow graphs and applying heuristics. **For production bots, Token Sniffer's $100-200/month API provides this analysis without implementing symbolic execution engines.**

### Speed vs accuracy: The 5-second decision window

**Competitive sniping requires decisions within 1-3 seconds of pool detection.** A practical implementation uses tiered checks:

**Level 1 (<1s):** GoPlus API honeypot flag (must pass)
**Level 2 (1-3s):** Honeypot.is simulation, liquidity lock check
**Level 3 (3-5s):** callStatic buy/sell simulation, tax calculation

```javascript
async function comprehensiveCheck(tokenAddress, maxTime = 5000) {
  const startTime = Date.now();

  // Parallel fast checks
  const [goPlus, honeypot] = await Promise.race([
    Promise.all([checkGoPlus(tokenAddress), checkHoneypot(tokenAddress)]),
    new Promise((_, reject) => setTimeout(() => reject("Timeout"), maxTime)),
  ]);

  // Quick rejection on red flags
  if (goPlus.is_honeypot === "1" || honeypot.IsHoneypot) return false;

  // Deeper checks if time permits
  const remainingTime = maxTime - (Date.now() - startTime);
  if (remainingTime > 1000) {
    return await Promise.race([
      simulateTrade(tokenAddress),
      new Promise((_, reject) =>
        setTimeout(() => reject("Timeout"), remainingTime)
      ),
    ]);
  }

  return true; // Pass if API checks passed
}
```

This architecture prioritizes speed while maintaining safety—the core engineering tradeoff in sniper bots.

## Wallet architecture: Custodial versus non-custodial reality

**Marketing claims of "non-custodial" often mislead users.** The technical implementations reveal important distinctions.

### BONKbot's revolutionary KMS architecture

BONKbot implements the most sophisticated wallet security: a custom-built Key Management System running on dedicated AMD servers with TPM 2.0 hardware security modules.

**The unikernel approach:**

- Hardened minimal Linux kernel + KMS application baked into single binary
- Direct boot by server firmware (no traditional OS)
- Written in memory-safe language (likely Rust), statically linked
- TPM measures boot process at each stage
- Management Engine and remote management disabled
- RAM encryption via AMD memory encryption
- No remote shell access

**Two isolated processes:**

1. **Message Bridge**: Synchronizes encrypted keys via message bus, provides API for business logic, **has zero direct access to private keys**
2. **Signer Process**: Manages encrypted keys, handles signature requests, **has no network access** (only communicates via Message Bridge)

**Master key protection** uses OpenSSH-inspired side-channel attack resistance:

- Stored as linked list of memory pages with random data
- Hash of pages read in correct order decrypts master key
- Constantly mutates to prevent memory scanning
- Only systems with TPM identity key can decrypt
- Zero engineer access—even developers cannot extract the master key

**User keys decrypt ephemerally**—existing in memory only during signature calculation (microseconds). The intent-based verification system generates human-readable transaction descriptions, using a commit-reveal protocol to ensure transactions match user intent. **WASM modules verify transaction "shape" in <0.5ms**, blocking any unauthorized instructions even if underlying protocols (Raydium, Jupiter) are compromised.

**This is genuinely non-custodial** while maintaining cloud convenience—the first bot achieving hardware wallet security without hardware.

### Banana Gun's hybrid custodial model

Banana Gun's architecture is technically custodial despite marketing. **Private keys are stored on a "separate encrypted server"** with multi-layer security (marshaling, hashing, conversion). The critical detail: "Only the bot can access the encrypted server."

This means the project team technically has access to private keys through the bot infrastructure. The September 2024 hack where $1.9M was stolen from user wallets validates this risk. **Users are advised to keep only trading funds in bot wallets** and transfer profits to secure personal wallets.

The security design prioritizes speed over absolute custody: keys exist in an encrypted server for instant signing without user interaction. This architectural choice enables millisecond-level execution but introduces custodial risk.

### Trojan and Maestro's encrypted storage

Both implement similar "non-custodial" architectures:

- Users receive 12-word seed phrases during wallet creation (shown only once)
- Private keys encrypted with AES-256 and stored in database
- Keys tied to Telegram account identity
- Platform cannot retrieve lost keys (per documentation)

**The critical question: who holds the encryption keys?** If the service encrypts user private keys with a master key the platform controls, it's functionally custodial. BONKbot's TPM-based master key protection addresses this; documentation doesn't reveal whether Trojan and Maestro implement similar protections.

**Multi-wallet support varies:** Maestro Premium allows 10 wallets, Banana Gun supports 5, BONKbot limits to 1 per Telegram account. This architectural choice impacts wallet tracking avoidance—multi-wallet strategies help evade copy trading and per-wallet transaction limits.

### Security recommendation for developers

**Implement a separation of concerns:**

- **Hot wallet (bot-controlled)**: Minimal funds for active trading, rapid execution
- **Warm wallet (2FA-protected)**: Larger trading capital, requires multi-factor authorization
- **Cold wallet (hardware)**: Profit storage, completely separate from bot infrastructure

BONKbot's implementation requiring 2FA for SOL withdrawals and private key exports represents best practice. Token whitelisting (optional 2FA for new tokens) adds another security layer without impacting execution speed for approved tokens.

## Multi-chain abstraction: Unifying heterogeneous blockchains

**Maestro's 10+ chain support represents the most complex multi-chain architecture.** The engineering challenge: EVM chains (Ethereum, BSC, Arbitrum, Base, Avalanche, Sonic) versus non-EVM chains (Solana, TON, Tron) have fundamentally different APIs, transaction formats, and gas models.

### The abstraction strategy

**Unified Telegram interface with chain-switching capability** hides complexity from users. Single command structure (`/sniper`, `/chains`, `/wallets`) works across all chains through backend chain detection based on contract address format.

**Technical implementation approach:**

**Layer 1: RPC Connection Abstraction**

- Standardized RPC integration connects to blockchain nodes via JSON-RPC or chain-specific APIs
- Separate WebSocket pools per chain for real-time monitoring
- Chain-specific configuration:
  - EVM: Gas Price/Delta, maxPriorityFeePerGas
  - Solana: Compute units, priority fees (microlamports)
  - Tron: Energy/Bandwidth model

**Layer 2: Smart Contract Interface**

- Universal ABI handling for EVM chains (ethers.js Interface class)
- Chain-specific libraries:
  - EVM: ethers.js/web3.js for contract interactions
  - Solana: @solana/web3.js + Anchor framework
  - TON: ton-client-js
  - Tron: tronweb

**Layer 3: Transaction Construction**

- Chain-specific transaction serialization and signing
- Different nonce management (sequential for EVM, recent blockhash for Solana)
- Gas estimation algorithms per chain

**Layer 4: DEX Integration**

- 30+ DEX router contracts with standardized swap interfaces
- Per-chain DEX support:
  - **Ethereum**: Uniswap V2/V3/V4, SushiSwap
  - **BSC**: PancakeSwap V2/V3, FourMeme
  - **Solana**: Raydium V4, Orca, Meteora, Pump.Fun, Jupiter aggregator
  - **Arbitrum**: Uniswap V3, SushiSwap, Camelot, OreoSwap
  - **Base**: Uniswap, Aerodrome, Virtuals Protocol
  - **Sonic**: 10+ DEXs (NDYOR, SonicSwap, SwapX, Wagmi V3)

### Banana Gun's selective multi-chain approach

Banana Gun supports 5 chains (Ethereum, Solana, Base, Blast, BSC) with **separate bot instances optimized per chain.** The architecture sacrifices unification for per-chain performance optimization.

**Key insight: Ethereum represents 80% of weekly volume.** This validates a focused approach—building exceptional Ethereum execution infrastructure, then replicating for high-value chains only. The $3.6M annual infrastructure cost suggests running separate RPC infrastructure, mempool monitors, and MEV integrations per chain.

For Solana specifically, Banana Gun merged buy/sell into a unified bot (2024 update), indicating initial separation then consolidation as code matured.

### Trojan's Solana-only specialization

Trojan takes the opposite approach: **deep Solana optimization at the cost of multi-chain support.** The ETH-SOL bridge provides cross-chain capital deployment without multi-chain trading. This architectural decision enables:

- Tighter integration with Jito MEV infrastructure
- Optimized Raydium/Jupiter routing
- Solana-specific features (Pump.fun migration sniping)
- Sub-2-second BOLT execution tuned for Solana's 400ms slots

**The engineering tradeoff:** Maestro's 10+ chains mean infrastructure complexity, testing burden, and feature parity challenges. Trojan's single-chain focus enables deeper optimization but limits addressable market to Solana ecosystem.

### For developers: Start single-chain, expand strategically

**Multi-chain from day one is architectural overengineering.** Begin with one chain (Ethereum or Solana based on target market), achieve exceptional execution, then replicate to high-volume chains. The abstraction layers (RPC, contract interface, transaction construction, DEX integration) can be designed for extensibility without implementing all chains simultaneously.

**Libraries facilitating multi-chain development:**

- **Viem**: High-performance TypeScript library for EVM chains
- **Ethers.js v6**: Cross-EVM compatibility
- **Solana Web3.js**: Solana standard
- **Multicall**: Batch multiple contract calls into single RPC request (EVM optimization)

## Technical stack: Languages, frameworks, and infrastructure

**None of the major bots have public GitHub repositories for their core code**—the competitive advantage is too valuable. However, documentation, clone script sources, and ecosystem analysis reveal likely technology choices.

### Language selection patterns

**Rust for performance-critical components:**

- Solana programs require Rust (native language)
- BONKbot's unikernel KMS likely Rust (memory-safe language in docs)
- High-performance mempool scanners benefit from Rust's zero-cost abstractions
- Example use: Transaction parsing, bytecode analysis, direct validator connections

**TypeScript/JavaScript for bot logic:**

- Telegram Bot API integration (node-telegram-bot-api, Telegraf)
- Rapid development and iteration
- Extensive Web3 library ecosystem (ethers.js, @solana/web3.js)
- Async/await patterns natural for blockchain operations
- Example: Maestro, Trojan, Banana Gun likely use Node.js backends

**Python as alternative:**

- Web3.py for Ethereum interactions
- Good for data analysis and ML-based detection
- Slower execution than Rust/TypeScript but adequate for non-critical paths
- Example: Security analysis pipelines, historical data processing

### Framework and infrastructure components

**Telegram Bot Framework:**

- Webhook-based updates for real-time responses
- Inline keyboard buttons for user interface (buy/sell buttons)
- Message editing for dynamic updates (position tracking)
- Mini-app framework for complex UIs (BONKbot's authorization interface)

**Database Layer:**

- **PostgreSQL or MySQL**: User settings, wallet associations, transaction history
- **Redis**: Caching frequently accessed data (token metadata, security results)
- Session management and real-time data
- Encrypted storage for private keys (AES-256)

**Message Queue/Bus:**

- Handles inter-process communication
- Decouples transaction monitoring from execution
- Example: RabbitMQ, Redis Pub/Sub, Kafka for high-throughput scenarios
- BONKbot's Message Bridge uses this pattern

**RPC Infrastructure:**

- **Premium providers required:** QuickNode, Alchemy, Helius (Solana)
- WebSocket connection pools for persistent real-time monitoring
- Multiple providers for redundancy and failover
- Geographic distribution (BONKbot mentions multi-region)
- Self-hosted validators for largest operations (estimated $50K+ annual TCO for Ethereum)

**Smart Contract Interaction:**

- **EVM**: ethers.js v6 Contract class with ABI interfaces
- **Solana**: Anchor programs with IDL (Interface Definition Language)
- **Transaction simulation**: callStatic (ethers.js) or simulate_transaction (Solana)

### Specific technical implementations

**Mempool Monitoring Service:**

```typescript
// Separate microservice handling blockchain monitoring
class MempoolMonitor {
  private providers: Map<string, WebSocketProvider>;
  private eventBus: EventEmitter;

  async monitorFactory(factoryAddress: string) {
    const factory = new ethers.Contract(factoryAddress, factoryABI, provider);
    factory.on("PairCreated", async (token0, token1, pair) => {
      this.eventBus.emit("newPair", { token0, token1, pair });
    });
  }
}
```

**Security Check Pipeline:**

```typescript
// Parallel security checks with timeout
class SecurityPipeline {
  async check(tokenAddress: string): Promise<SecurityResult> {
    const checks = await Promise.allSettled([
      this.checkGoPlus(tokenAddress),
      this.checkHoneypotIs(tokenAddress),
      this.simulateTrade(tokenAddress),
      this.checkLiquidity(tokenAddress),
    ]);

    return this.aggregateResults(checks);
  }
}
```

**Transaction Execution Service:**

```typescript
// Handles gas optimization and transaction submission
class ExecutionEngine {
  async executeBuy(params: BuyParams): Promise<TransactionReceipt> {
    const gasPrice = await this.calculateOptimalGas(params.urgency);
    const tx = await this.router.swapExactETHForTokens(
      params.amountOutMin,
      params.path,
      params.recipient,
      params.deadline,
      {
        value: params.ethAmount,
        gasPrice,
        gasLimit: 500000,
      }
    );
    return tx.wait();
  }
}
```

### Infrastructure cost considerations

**Banana Gun's $3.6M annual infrastructure investment** breaks down approximately:

- Premium RPC endpoints: $50-100K/year per chain
- Server infrastructure: $10-20K/month for high-availability
- Mempool monitoring infrastructure: Custom nodes and co-location
- Development and maintenance: 5-10 engineer team
- Security audits: $50-100K per audit

For independent developers, a competitive bot requires:

- **Minimum viable**: $500-1,000/month (premium RPC, basic servers)
- **Competitive**: $5-10K/month (custom infrastructure, multiple chains)
- **Professional**: $50K+/month (dedicated nodes, MEV infrastructure, multi-region)

## Anti-bot measures: The adversarial environment

**Token developers actively implement countermeasures against sniper bots**, creating an arms race requiring constant adaptation.

### Common anti-bot techniques

**1. Deadblock/Honeypot Blocks:**

- First X blocks after launch have transfer restrictions
- Buying in these blocks triggers blacklisting
- **Detection**: Maestro and Banana Gun implement dynamic deadblock detection analyzing contract code for blacklist functions, tax change mechanisms, and transfer restrictions

**2. Bot Wallet Blacklisting:**

- Projects track known bot wallet addresses
- Implement transfer restrictions for these addresses
- **Mitigation**: Fresh wallet generation (Trojan allows 10 wallets, Maestro Premium 10, BONKbot limited to 1)

**3. Maximum Transaction Limits:**

- Contracts enforce max transaction amounts (e.g., 1% of supply)
- Prevents large bot purchases
- **Adaptation**: Trojan's "Dynamic Max Buy Adjustment" never exceeds contract's maxTransactionAmount, automatically reducing user's buy size

**4. Time-based Cooldowns:**

- Require X seconds between buy and sell
- Detect rapid bot trading patterns
- **Workaround**: Multi-wallet strategies (buy with wallet A, sell with wallet B)

**5. Whitelist-Only Initial Trading:**

- Only approved addresses can trade initially
- Opens to public after set time
- **No technical workaround**—bots wait for public opening

### Bot defensive strategies

**Transaction Privacy:**

- **Private mempool routing**: 97% of Banana Gun transactions via private paths
- **Flashbots for Ethereum**: Bundle submission keeps transactions hidden until mined
- **Jito for Solana**: Bundle submission through Block Engine bypasses public transaction broadcasting

**Transaction Pattern Obfuscation:**

- Variable priority fees (mimics human behavior)
- Randomized transaction timing
- Different transaction construction patterns
- Intent-based architecture (BONKbot) makes transactions appear more "natural"

**MEV Protection as Defensive Tool:**

- Prevents other bots from sandwiching your trades
- Jito's `jitodontfront` account inclusion blocks sandwich attempts
- Flashbots bundles with transaction ordering guarantees

**Infrastructure Advantages:**

- Custom RPC nodes harder to detect than public endpoint users
- Direct validator connections bypass many detection mechanisms
- Co-location reduces identifiable network patterns

### The Exclusive Order Flow moat

**Banana Gun's partnership with Titan Builder** represents an architectural moat competitors cannot replicate through feature copying alone. Exclusive orderflow routing means:

- Transactions reach block builders before competitor bots
- Priority positioning regardless of gas price
- Economic relationship that grew Titan from 1% to 40% market share

**This demonstrates a key insight:** Technical architecture alone is insufficient—business relationships with validators/builders create sustainable competitive advantages. For new entrants, similar partnerships are increasingly difficult as major builders have established relationships.

### Detection arms race continues

**Projects are developing more sophisticated bot detection:**

- Transaction simulation analysis (detecting callStatic patterns)
- Network timing analysis (sub-second execution patterns)
- Wallet funding patterns (freshly funded wallets from exchange)
- Gas price patterns (consistently high priority fees)

**Bot developers respond with:**

- Longer "aging" of wallets before use
- Gradual funding patterns
- Variable gas strategies
- Increasingly sophisticated transaction construction

**For developers:** Build adaptability into architecture. Hardcoded anti-detection patterns quickly become obsolete; implement configurable strategies that can evolve as projects adapt.

## Synthesis: Building your own sniper bot

**Start with clear architectural decisions based on target market:**

**Single-chain specialist (Trojan model):**

- Deep optimization for chosen chain
- Faster time to market
- Lower infrastructure costs
- Strong competitive position in niche

**Multi-chain platform (Maestro model):**

- Broader market access
- Higher development complexity
- Larger infrastructure investment
- Feature parity challenges across chains

**Core components in order of implementation:**

**Phase 1 - Detection:**

1. WebSocket RPC connections (ethers.js for EVM, @solana/web3.js for Solana)
2. Factory contract monitoring for PairCreated events
3. Basic transaction filtering and token extraction
4. Telegram bot interface for user interaction

**Phase 2 - Security:**

1. GoPlus API integration (free, easy, essential)
2. Honeypot.is API integration for simulation
3. callStatic buy/sell simulation implementation
4. Tax detection and calculation
5. Configurable safety thresholds

**Phase 3 - Execution:**

1. Router contract integration (Uniswap V2/V3, Raydium)
2. Dynamic gas price calculation
3. Transaction submission with retry logic
4. Position monitoring and P&L tracking

**Phase 4 - Optimization:**

1. Private RPC node setup or premium provider
2. MEV protection (Flashbots/Jito integration)
3. Bundle submission for Block 0 sniping
4. Multi-wallet support
5. Advanced security features (liquidity lock verification, bytecode analysis)

**Phase 5 - Scale:**

1. Database layer for user management
2. Redis caching for performance
3. Message queue for decoupled architecture
4. Multi-region deployment
5. Monitoring and alerting infrastructure

**Critical success factors beyond technical implementation:**

- **Speed is everything**: Private RPC nodes are non-negotiable for profitability
- **Security determines reputation**: One major exploit destroys user trust permanently
- **User experience matters**: Telegram interface must be intuitive despite complexity
- **Infrastructure costs**: Budget $5-10K/month minimum for competitive operation
- **Regulatory compliance**: Unclear regulatory status requires legal consultation
- **Continuous adaptation**: Bot detection evolves; architecture must support rapid changes

**The fundamental engineering challenge:** Balance execution speed, security verification, and user experience within the 1-3 second decision window of competitive token launches. Every millisecond of security checking delays execution; every shortcut in verification risks user funds. The most successful bots optimize this tradeoff through parallel processing, tiered checks, and sophisticated caching.

The four leaders—Trojan, Banana Gun, Maestro, and BONKbot—demonstrate different solutions to the same problem. Study their architectures, understand their tradeoffs, then build something better.
