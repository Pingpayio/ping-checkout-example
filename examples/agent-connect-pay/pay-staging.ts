#!/usr/bin/env bun
/**
 * Agent Connect (MCP) → Ping Agent Pay staging example.
 *
 * Flow: prepare → gross-up withdraw_preview → withdraw → poll get_operation
 * (destination_tx_hash) → verify/settle. Agent Connect dashboard + MCP docs:
 * https://agent-connect-app-production.up.railway.app/docs/connect-agent
 *
 *   bun run pay-staging.ts check          # read-only MCP + Ping supported/prepare + one preview
 *   bun run pay-staging.ts pay --confirm  # moves funds on Base via Agent Connect withdraw
 *
 * Copy `.env.example` → `.env` and fill variable names (never commit secrets).
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_ACCOUNT,
  DEFAULT_MCP_URL,
  DEFAULT_NEAR_USDC_TOKEN,
  DEFAULT_STAGING_BASE,
  env,
  loadEnvFiles,
} from './lib/env.ts';
import { AgentConnectMcp } from './lib/mcp.ts';
import {
  assertPayableChallenge,
  formatUsdc,
  getSupported,
  prepareChallenge,
  verifyAndSettle,
} from './lib/ping-agent-pay.ts';
import {
  blockingPolicyWarnings,
  extractDestinationTxHash,
  grossUpWithdrawPreview,
  pollOperationToSuccess,
  type WithdrawPreviewQuote,
} from './lib/gross-up-withdraw.ts';

loadEnvFiles();

const MCP_URL = env('AGENT_CONNECT_MCP_URL', DEFAULT_MCP_URL);
const AGENT_KEY = env('AGENT_CONNECT_KEY') || env('Agent_connect_key');
const ACCOUNT = env('AGENT_CONNECT_ACCOUNT', DEFAULT_ACCOUNT);
const BASE_URL = env('STAGING_BASE_URL', DEFAULT_STAGING_BASE).replace(/\/$/, '');
const API_KEY = env('PINGPAY_STAGING_API_KEY');
const TEST_AMOUNT = env('TEST_AMOUNT_USDC', '0.2');
const WITHDRAW_TOKEN = env('NEAR_USDC_WITHDRAW_TOKEN', DEFAULT_NEAR_USDC_TOKEN);
const WITHDRAW_CHAIN = 'base';

function step(msg: string) {
  console.log(`\n==> ${msg}`);
}

function fail(msg: string): never {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

function requireAgentKey() {
  if (!AGENT_KEY) {
    fail(
      'AGENT_CONNECT_KEY is not set. Issue a 30-day key in Agent Connect (Dashboard → Agent Integrations) ' +
        'and add it to examples/agent-connect-pay/.env or repo-root .env.agent-pay.',
    );
  }
}

function requirePingKey() {
  if (!API_KEY) {
    fail(
      'PINGPAY_STAGING_API_KEY is not set. Create a staging dashboard API key (Agent Pay enabled) ' +
        'and add it to .env / .env.agent-pay.',
    );
  }
}

async function mcpPreflight(mcp: AgentConnectMcp) {
  step('MCP get_accounts');
  const accounts = await mcp.callTool<{ accounts?: unknown[] }>('get_accounts', {});
  console.log(JSON.stringify(accounts, null, 2));

  step('MCP get_balances (confidential)');
  const balances = await mcp.callTool('get_balances', { source: 'confidential', account: ACCOUNT });
  console.log(JSON.stringify(balances, null, 2));

  step('MCP get_network_status');
  const network = await mcp.callTool('get_network_status', {});
  console.log(JSON.stringify(network, null, 2));

  step('MCP get_policy');
  const policy = await mcp.callTool('get_policy', { account: ACCOUNT });
  console.log(JSON.stringify(policy, null, 2));
}

async function modeCheck() {
  step(`GET ${BASE_URL}/agentpay/x402/supported`);
  console.log(JSON.stringify(await getSupported(BASE_URL), null, 2));

  if (!AGENT_KEY) {
    console.log('\nAGENT_CONNECT_KEY not set — skipping MCP preflight.');
  } else {
    const mcp = new AgentConnectMcp(MCP_URL, AGENT_KEY);
    await mcp.connect();
    try {
      await mcpPreflight(mcp);
    } finally {
      await mcp.disconnect();
    }
  }

  if (!API_KEY) {
    console.log(
      '\nPINGPAY_STAGING_API_KEY not set — skipping prepare (would 401). Set it for a full check.',
    );
    console.log('\ncheck complete — no withdraw, no settle.');
    return;
  }

  step(`Ping prepare (amountOut = ${TEST_AMOUNT} USDC to merchant)`);
  const prepared = await prepareChallenge(BASE_URL, API_KEY, TEST_AMOUNT);
  assertPayableChallenge(prepared);
  console.log(JSON.stringify(prepared, null, 2));
  console.log(
    `\nChallenge ${prepared.agentPayChallengeId}: deliver >= ${formatUsdc(prepared.amount)} USDC on Base to ${prepared.payTo} ` +
      `(expires ${prepared.expiresAt}).`,
  );

  if (!AGENT_KEY) {
    console.log('\ncheck complete — prepare only (no MCP preview without AGENT_CONNECT_KEY).');
    return;
  }

  const mcp = new AgentConnectMcp(MCP_URL, AGENT_KEY);
  await mcp.connect();
  try {
    step('MCP withdraw_preview (single quote at prepare.amount — gross-up shown, no withdraw)');
    const preview = await mcp.callTool<WithdrawPreviewQuote>('withdraw_preview', {
      account: ACCOUNT,
      token: WITHDRAW_TOKEN,
      amount: prepared.amount,
      chain: WITHDRAW_CHAIN,
      to: prepared.payTo,
    });
    console.log(JSON.stringify(preview, null, 2));
    const blocks = blockingPolicyWarnings(preview);
    if (blocks.length) console.log(`\nPolicy warnings (non-balance): ${blocks.join('; ')}`);
    const out = preview.quote?.amount_out;
    if (out && BigInt(out) < BigInt(prepared.amount)) {
      console.log(
        `\nNote: naive source=${prepared.amount} delivers amount_out=${out} (< required ${prepared.amount}). ` +
          '`pay --confirm` runs gross-up previews before withdraw (see live-checks §11).',
      );
    }
  } finally {
    await mcp.disconnect();
  }

  console.log('\ncheck complete — no withdraw, no verify/settle.');
}

async function modePay(confirm: boolean) {
  if (!confirm) {
    fail('pay moves real funds via Agent Connect withdraw. Re-run with: pay --confirm');
  }
  requireAgentKey();
  requirePingKey();

  const mcp = new AgentConnectMcp(MCP_URL, AGENT_KEY!);
  await mcp.connect();
  try {
    await mcpPreflight(mcp);

    step(`Ping prepare (TEST_AMOUNT_USDC=${TEST_AMOUNT})`);
    const prepared = await prepareChallenge(BASE_URL, API_KEY!, TEST_AMOUNT);
    assertPayableChallenge(prepared);
    console.log(
      `payTo=${prepared.payTo} required delivery amount=${prepared.amount} (${formatUsdc(prepared.amount)} USDC)`,
    );

    const requiredOut = BigInt(prepared.amount);
    step('MCP gross-up withdraw_preview (up to 3 previews)');
    const gross = await grossUpWithdrawPreview(mcp, {
      account: ACCOUNT,
      token: WITHDRAW_TOKEN,
      chain: WITHDRAW_CHAIN,
      to: prepared.payTo,
      requiredAmountOut: requiredOut,
      maxPreviews: 3,
    });
    console.log(
      `Gross-up: source=${gross.sourceAmount} → amount_out=${gross.amountOut} (min=${gross.minAmountOut}) ` +
        `after ${gross.previewsUsed} preview(s)`,
    );

    const idempotencyKey = `ping:${prepared.agentPayChallengeId}:${randomUUID()}`;
    step(`MCP withdraw (idempotency_key=${idempotencyKey})`);
    const submitted = await mcp.callTool<{ operation_id?: string; status?: string }>('withdraw', {
      account: ACCOUNT,
      token: WITHDRAW_TOKEN,
      amount: gross.sourceAmount.toString(),
      chain: WITHDRAW_CHAIN,
      to: prepared.payTo,
      idempotency_key: idempotencyKey,
    });
    console.log(JSON.stringify(submitted, null, 2));
    const operationId = submitted.operation_id;
    if (!operationId) fail('withdraw response missing operation_id');

    step(`Poll get_operation until SUCCESS (${operationId})`);
    const terminal = await pollOperationToSuccess(mcp, operationId, {
      timeoutMs: prepared.maxTimeoutSeconds * 1000,
    });
    console.log(JSON.stringify(terminal, null, 2));

    const txHash = extractDestinationTxHash(terminal);
    console.log(`\nBase destination tx: ${txHash}`);
    console.log(`Explorer: https://basescan.org/tx/${txHash}`);

    step('Ping verify + settle');
    const { verify, settle } = await verifyAndSettle(BASE_URL, API_KEY!, txHash, prepared);
    console.log('verify:', JSON.stringify(verify, null, 2));
    console.log('settle:', JSON.stringify(settle, null, 2));
    console.log('\npay complete.');
  } finally {
    await mcp.disconnect();
  }
}

const [mode, ...rest] = process.argv.slice(2);
try {
  if (mode === 'check') {
    await modeCheck();
  } else if (mode === 'pay') {
    await modePay(rest.includes('--confirm'));
  } else {
    console.log(
      'Usage:\n' +
        '  bun run pay-staging.ts check\n' +
        '  bun run pay-staging.ts pay --confirm\n\n' +
        'Env: see .env.example (AGENT_CONNECT_KEY, PINGPAY_STAGING_API_KEY, …)',
    );
    process.exit(mode ? 1 : 0);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
