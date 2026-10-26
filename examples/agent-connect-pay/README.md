# Agent Connect → Ping Agent Pay (staging example)

Standalone Bun example showing an **Agent Connect MCP** wallet paying a **Ping Agent Pay** x402 challenge on staging.

Uses the hosted **Agent Connect** MCP endpoint (`POST …/mcp`, `Authorization: Bearer $AGENT_CONNECT_KEY`). Setup and tool names are in the Agent Connect docs: [overview](https://agent-connect-app-production.up.railway.app/docs/overview), [Connect your agent](https://agent-connect-app-production.up.railway.app/docs/connect-agent), [MCP tools](https://agent-connect-app-production.up.railway.app/docs/mcp-tools).

End-to-end flow: Ping `prepare` → gross-up `withdraw_preview` → `withdraw` → poll `get_operation` for `destination_tx_hash` → Ping `verify`/`settle`.

## Setup

1. Copy `.env.example` → `.env` in this directory (or use repo-root `.env.agent-pay` with the same variable **names**).
2. **Agent Connect:** owner dashboard → Agent Integrations → API key scoped to a funded account (e.g. `Checking`).
3. **Ping staging:** dashboard API key on an org with Agent Pay enabled; use `TEST_AMOUNT_USDC` ≥ `0.2` (1Click bridge minimum on staging).

## Commands

```bash
cd examples/agent-connect-pay
bun run check                 # read-only: MCP preflight + Ping supported/prepare + one preview
bun run pay -- --confirm      # real withdraw + verify/settle (Base mainnet)
```

Or directly:

```bash
bun run pay-staging.ts check
bun run pay-staging.ts pay --confirm
```

## Gross-up

Bridged `withdraw` delivers **`amount_out` on Base**, not necessarily the source Intents amount. Ping requires delivery ≥ the prepare response `amount`. The script runs up to three `withdraw_preview` calls to gross up the source before a single `withdraw`.

## Not a Ping product

Example glue only — do not ship as production payer infrastructure. For CDP/private-key staging tests see `scripts/agent-pay-staging-test.ts` on the agent-pay staging branch.
