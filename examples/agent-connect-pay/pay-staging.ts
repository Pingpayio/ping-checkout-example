#!/usr/bin/env bun
/**
 * Agent Connect (MCP) → Ping Agent Pay staging example.
 *
 * Default flow (v2, PR 3370): offers → verify (quote) → gross-up withdraw → settle (deposit).
 * Legacy: POST /prepare → withdraw → txHash verify/settle.
 *
 *   bun run pay-staging.ts check [--flow v2|legacy]
 *   bun run pay-staging.ts pay --confirm [--flow v2|legacy]
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
  assertQuotedChallenge,
  formatUsdc,
  getSupported,
  mintQuoteViaVerify,
  prepareChallenge,
  settleDeposit,
  verifyAndSettle,
  withdrawToForBaseChain,
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
const REFUND_ADDRESS = env('REFUND_ADDRESS') || env('refundAddress');
const WITHDRAW_TOKEN = env('NEAR_USDC_WITHDRAW_TOKEN', DEFAULT_NEAR_USDC_TOKEN);
const WITHDRAW_CHAIN = 'base';

type PayFlow = 'v2' | 'legacy';

function step(msg: string) {
  console.log(`\n==> ${msg}`);
}

function fail(msg: string): never {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

function parseFlow(argv: string[]): PayFlow {
  const idx = argv.indexOf('--flow');
  if (idx >= 0) {
    const value = argv[idx + 1]?.toLowerCase();
    if (value === 'v2' || value === 'legacy') return value;
    fail('--flow must be "v2" or "legacy"');
  }
  return 'v2';
}

function stripFlowFlag(argv: string[]): string[] {
  const out = [...argv];
  const idx = out.indexOf('--flow');
  if (idx >= 0) out.splice(idx, 2);
  return out;
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

function requireRefundAddress(): string {
  const addr = REFUND_ADDRESS?.trim() ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    fail(
      'REFUND_ADDRESS is required for the v2 quote flow: a Base mainnet EVM address (0x + 40 hex) ' +
        'on the payer origin chain for 1Click refunds. Use the Agent Connect linked EVM account ' +
        'address from MCP get_accounts if needed. Set REFUND_ADDRESS in .env or repo-root .env.agent-pay.',
    );
  }
  return addr;
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

async function previewWithdrawAtDeposit(
  mcp: AgentConnectMcp,
  depositAddress: string,
  requiredBaseDelivery: string,
  label: string,
) {
  const withdrawTo = withdrawToForBaseChain(depositAddress);
  if (withdrawTo !== depositAddress) {
    console.log(`\nMCP withdraw to (normalized from depositAddress): ${withdrawTo}`);
  }
  step(label);
  const preview = await mcp.callTool<WithdrawPreviewQuote>('withdraw_preview', {
    account: ACCOUNT,
    token: WITHDRAW_TOKEN,
    amount: requiredBaseDelivery,
    chain: WITHDRAW_CHAIN,
    to: withdrawTo,
  });
  console.log(JSON.stringify(preview, null, 2));
  const blocks = blockingPolicyWarnings(preview);
  if (blocks.length) console.log(`\nPolicy warnings (non-balance): ${blocks.join('; ')}`);
  const out = preview.quote?.amount_out;
  if (out && BigInt(out) < BigInt(requiredBaseDelivery)) {
    console.log(
      `\nNote: naive source=${requiredBaseDelivery} delivers amount_out=${out} (< requiredBaseDelivery ${requiredBaseDelivery}). ` +
        '`pay --confirm` runs gross-up previews before withdraw.',
    );
  }
}

async function modeCheckV2() {
  step(`GET ${BASE_URL}/agentpay/x402/supported`);
  console.log(JSON.stringify(await getSupported(BASE_URL), null, 2));

  if (AGENT_KEY) {
    const mcp = new AgentConnectMcp(MCP_URL, AGENT_KEY);
    await mcp.connect();
    try {
      await mcpPreflight(mcp);
    } finally {
      await mcp.disconnect();
    }
  } else {
    console.log('\nAGENT_CONNECT_KEY not set — skipping MCP preflight.');
  }

  if (!API_KEY) {
    console.log(
      '\nPINGPAY_STAGING_API_KEY not set — skipping offers/verify quote. Set it for a full check.',
    );
    console.log('\ncheck complete (v2) — no withdraw, no settle.');
    return;
  }

  const refundTo = requireRefundAddress();
  step(`Ping offers + verify quote (amountOut = ${TEST_AMOUNT} USDC, refundTo set)`);
  const quoted = await mintQuoteViaVerify(BASE_URL, API_KEY, {
    refundTo,
    amountOutHuman: TEST_AMOUNT,
    description: 'Agent Connect MCP payer example (check)',
  });
  assertQuotedChallenge(quoted);
  console.log(JSON.stringify(quoted, null, 2));
  console.log(
    `\nQuoted deposit: 1Click amountIn=${quoted.amountIn} → MCP requiredBaseDelivery=${quoted.requiredBaseDelivery} ` +
      `(${formatUsdc(quoted.requiredBaseDelivery)} USDC at Base to) merchant amountOut=${quoted.amountOut}. operationToken minted.`,
  );
  if (quoted.requiredBaseDelivery !== quoted.amountIn) {
    console.log(
      'Note: verify amountIn uses 1Click origin units; MCP gross-up uses requiredBaseDelivery (Base delivery atoms).',
    );
  }

  if (!AGENT_KEY) {
    console.log('\ncheck complete (v2) — quote mint OK (no MCP preview without AGENT_CONNECT_KEY).');
    return;
  }

  const mcp = new AgentConnectMcp(MCP_URL, AGENT_KEY);
  await mcp.connect();
  try {
    await previewWithdrawAtDeposit(
      mcp,
      quoted.depositAddress,
      quoted.requiredBaseDelivery,
      'MCP withdraw_preview (requiredBaseDelivery — gross-up shown, no withdraw)',
    );
  } finally {
    await mcp.disconnect();
  }

  console.log('\ncheck complete (v2) — no withdraw, no settle.');
}

async function modeCheckLegacy() {
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
    console.log('\ncheck complete (legacy) — no withdraw, no settle.');
    return;
  }

  const refundTo = REFUND_ADDRESS?.trim();
  step(`Ping prepare (amountOut = ${TEST_AMOUNT} USDC${refundTo ? ', refundAddress set' : ''})`);
  const prepared = await prepareChallenge(BASE_URL, API_KEY, TEST_AMOUNT, refundTo);
  assertPayableChallenge(prepared);
  console.log(JSON.stringify(prepared, null, 2));
  console.log(
    `\nChallenge ${prepared.agentPayChallengeId}: deliver >= ${formatUsdc(prepared.amount)} USDC to ${prepared.payTo} ` +
      `(expires ${prepared.expiresAt}).`,
  );

  if (!AGENT_KEY) {
    console.log('\ncheck complete (legacy) — prepare only (no MCP preview without AGENT_CONNECT_KEY).');
    return;
  }

  const mcp = new AgentConnectMcp(MCP_URL, AGENT_KEY);
  await mcp.connect();
  try {
    await previewWithdrawAtDeposit(
      mcp,
      prepared.payTo,
      prepared.amount,
      'MCP withdraw_preview (single quote at prepare.amount — gross-up shown, no withdraw)',
    );
  } finally {
    await mcp.disconnect();
  }

  console.log('\ncheck complete (legacy) — no withdraw, no verify/settle.');
}

async function modePayV2(confirm: boolean) {
  if (!confirm) {
    fail('pay moves real funds via Agent Connect withdraw. Re-run with: pay --confirm');
  }
  requireAgentKey();
  requirePingKey();
  const refundTo = requireRefundAddress();

  const mcp = new AgentConnectMcp(MCP_URL, AGENT_KEY!);
  await mcp.connect();
  try {
    await mcpPreflight(mcp);

    step(`Ping verify quote (TEST_AMOUNT_USDC=${TEST_AMOUNT}, REFUND_ADDRESS set)`);
    const quoted = await mintQuoteViaVerify(BASE_URL, API_KEY!, {
      refundTo,
      amountOutHuman: TEST_AMOUNT,
      description: 'Agent Connect MCP payer example (pay)',
    });
    assertQuotedChallenge(quoted);
    const withdrawTo = withdrawToForBaseChain(quoted.depositAddress);
    console.log(
      `depositAddress=${quoted.depositAddress} withdrawTo=${withdrawTo} amountIn=${quoted.amountIn} ` +
        `requiredBaseDelivery=${quoted.requiredBaseDelivery} (${formatUsdc(quoted.requiredBaseDelivery)} USDC delivery target)`,
    );

    const requiredOut = BigInt(quoted.requiredBaseDelivery);
    step('MCP gross-up withdraw_preview (up to 3 previews)');
    const gross = await grossUpWithdrawPreview(mcp, {
      account: ACCOUNT,
      token: WITHDRAW_TOKEN,
      chain: WITHDRAW_CHAIN,
      to: withdrawTo,
      requiredAmountOut: requiredOut,
      maxPreviews: 3,
    });
    console.log(
      `Gross-up: source=${gross.sourceAmount} → amount_out=${gross.amountOut} (min=${gross.minAmountOut}) ` +
        `after ${gross.previewsUsed} preview(s)`,
    );

    const idempotencyKey = `ping:v2:${quoted.depositAddress}:${randomUUID()}`;
    step(`MCP withdraw (idempotency_key=${idempotencyKey})`);
    const submitted = await mcp.callTool<{ operation_id?: string; status?: string }>('withdraw', {
      account: ACCOUNT,
      token: WITHDRAW_TOKEN,
      amount: gross.sourceAmount.toString(),
      chain: WITHDRAW_CHAIN,
      to: withdrawTo,
      idempotency_key: idempotencyKey,
    });
    console.log(JSON.stringify(submitted, null, 2));
    const operationId = submitted.operation_id;
    if (!operationId) fail('withdraw response missing operation_id');

    step(`Poll get_operation until SUCCESS (${operationId})`);
    const terminal = await pollOperationToSuccess(mcp, operationId, {
      timeoutMs: quoted.maxTimeoutSeconds * 1000,
    });
    console.log(JSON.stringify(terminal, null, 2));

    const txHash = extractDestinationTxHash(terminal);
    console.log(`\nOrigin / destination tx hash: ${txHash}`);
    console.log(`Explorer (if Base): https://basescan.org/tx/${txHash}`);

    step('Ping settle (deposit payload + operationToken; depositAddress from verify)');
    const { settle } = await settleDeposit(BASE_URL, API_KEY!, quoted, txHash);
    console.log('settle:', JSON.stringify(settle, null, 2));
    console.log('\npay complete (v2).');
  } finally {
    await mcp.disconnect();
  }
}

async function modePayLegacy(confirm: boolean) {
  if (!confirm) {
    fail('pay moves real funds via Agent Connect withdraw. Re-run with: pay --confirm');
  }
  requireAgentKey();
  requirePingKey();

  const mcp = new AgentConnectMcp(MCP_URL, AGENT_KEY!);
  await mcp.connect();
  try {
    await mcpPreflight(mcp);

    const refundTo = REFUND_ADDRESS?.trim();
    step(`Ping prepare (TEST_AMOUNT_USDC=${TEST_AMOUNT})`);
    const prepared = await prepareChallenge(BASE_URL, API_KEY!, TEST_AMOUNT, refundTo);
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

    step('Ping verify + settle (legacy txHash)');
    const { verify, settle } = await verifyAndSettle(BASE_URL, API_KEY!, txHash, prepared);
    console.log('verify:', JSON.stringify(verify, null, 2));
    console.log('settle:', JSON.stringify(settle, null, 2));
    console.log('\npay complete (legacy).');
  } finally {
    await mcp.disconnect();
  }
}

const rawArgs = process.argv.slice(2);
const flow = parseFlow(rawArgs);
const rest = stripFlowFlag(rawArgs);
const [mode, ...modeRest] = rest;

try {
  if (mode === 'check') {
    if (flow === 'v2') await modeCheckV2();
    else await modeCheckLegacy();
  } else if (mode === 'pay') {
    if (flow === 'v2') await modePayV2(modeRest.includes('--confirm'));
    else await modePayLegacy(modeRest.includes('--confirm'));
  } else {
    console.log(
      'Usage:\n' +
        '  bun run pay-staging.ts check [--flow v2|legacy]\n' +
        '  bun run pay-staging.ts pay --confirm [--flow v2|legacy]\n\n' +
        'Default flow: v2 (offers → verify quote → withdraw → settle deposit).\n' +
        'Env: see .env.example (AGENT_CONNECT_KEY, PINGPAY_STAGING_API_KEY, REFUND_ADDRESS, …)',
    );
    process.exit(mode ? 1 : 0);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
