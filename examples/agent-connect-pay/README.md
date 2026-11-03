# Agent Connect → Ping Agent Pay (staging example)

Standalone Bun example showing an **Agent Connect MCP** wallet paying a **Ping Agent Pay** x402 challenge on staging.

Uses the hosted **Agent Connect** MCP endpoint (`POST …/mcp`, `Authorization: Bearer $AGENT_CONNECT_KEY`). Setup and tool names are in the Agent Connect docs: [overview](https://agent-connect-app-production.up.railway.app/docs/overview), [Connect your agent](https://agent-connect-app-production.up.railway.app/docs/connect-agent), [MCP tools](https://agent-connect-app-production.up.railway.app/docs/mcp-tools).

## Default flow (v2 — PR 3370)

Matches `@pingpay/agentpay-middleware` and live merchants: **no `/prepare`**.

1. `GET /agentpay/x402/offers?amountOut=…` — unquoted accepts (Base origin).
2. `POST /agentpay/x402/verify` with **`payload.type: "quote"`** and **`refundTo`** — set **`REFUND_ADDRESS`** to a **Base mainnet EVM address** (`0x` + 40 hex; the Agent Connect linked EVM account from `get_accounts` works). Mints `depositAddress` (staging may return `deposit_agentpay_*` or origin-chain hex), `amountIn`, `operationToken`.
3. Agent Connect gross-up **`withdraw_preview`** → **`withdraw`** → poll **`get_operation`** for `destination_tx_hash`.
4. `POST /agentpay/x402/settle` with **`payload.type: "deposit"`** (`operationToken`, `depositAddress`, `txHash`).

Legacy **`POST /prepare`** remains available with `--flow legacy` (txHash verify/settle after withdraw).

## Setup

1. Copy `.env.example` → `.env` in this directory (or use repo-root `.env.agent-pay` with the same variable **names**).
2. **Agent Connect:** owner dashboard → Agent Integrations → API key scoped to a funded account (e.g. `Checking`).
3. **Ping staging:** dashboard API key on an org with Agent Pay enabled; set **`REFUND_ADDRESS`** to your **Base EVM** refund address for v2; use `TEST_AMOUNT_USDC` ≥ `0.2` (1Click bridge minimum on staging).

## Commands

```bash
cd examples/agent-connect-pay
bun run check                 # v2: MCP + supported + verify quote (+ preview if keys set)
bun run pay -- --confirm      # v2: real withdraw + settle(deposit)

# Legacy prepare path
bun run pay-staging.ts check --flow legacy
bun run pay-staging.ts pay --confirm --flow legacy
```

Or directly:

```bash
bun run pay-staging.ts check
bun run pay-staging.ts pay --confirm
```

## Gross-up

Bridged `withdraw` delivers **`amount_out` on Base at `to`**, not necessarily the source Intents amount. Ping **`verify`** returns 1Click **`amountIn`** (origin deposit units) plus merchant **`amountOut`** (destination USDC, same base units as **`TEST_AMOUNT_USDC`**). For NEAR Intents → Base MCP withdraw, gross-up sizes on **`requiredBaseDelivery`**: Base USDC atoms that must arrive at the deposit address — usually **`amountOut`** when `amountIn` is not 6-decimal Base-sized (legacy **`prepare.amount`** behaved the same on staging). The script runs up to three `withdraw_preview` calls before one `withdraw`.

**Deposit address shapes:** Ping may return `deposit_agentpay_…` (NEAR) or a **hex** origin deposit (common on staging). For MCP `chain: base`, the example normalizes hex deposits to the Base **`to`** address while **`settle`** still uses the exact `depositAddress` from verify.

## Not a Ping product

Example glue only — do not ship as production payer infrastructure. For CDP/private-key staging tests see `scripts/agent-pay-staging-test.ts` (compatibility `/prepare` payer, not this middleware flow).
