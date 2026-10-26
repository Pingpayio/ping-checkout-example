import type { AgentConnectMcp } from './mcp.ts';

export type WithdrawPreviewQuote = {
  quote?: {
    amount_out?: string;
    min_amount_out?: string;
    time_estimate_seconds?: number;
    fee?: unknown;
  };
  spend?: { amount_usd?: string };
  warnings?: Array<{ code?: string; message?: string; [key: string]: unknown }>;
};

const POLICY_WARNING_CODES = new Set([
  'frozen',
  'owner_approval_required',
  'timelock',
  'destination_not_allowed',
  'limit_exceeded',
  'schedule_blocked',
  'high_fee',
]);

export function blockingPolicyWarnings(preview: WithdrawPreviewQuote): string[] {
  const warnings = preview.warnings ?? [];
  return warnings
    .filter((w) => w.code && POLICY_WARNING_CODES.has(w.code))
    .map((w) => `${w.code}: ${w.message ?? JSON.stringify(w)}`);
}

export type GrossUpResult = {
  sourceAmount: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  previewsUsed: number;
  lastPreview: WithdrawPreviewQuote;
};

/**
 * Find a withdraw source amount so `quote.amount_out` >= required delivery at `payTo`.
 * Bridged withdrawals are net-of-cost; Ping requires delivery >= prepare.amount (see live E2E §11).
 */
export async function grossUpWithdrawPreview(
  mcp: AgentConnectMcp,
  args: {
    account: string;
    token: string;
    chain: string;
    to: string;
    requiredAmountOut: bigint;
    maxPreviews: number;
  },
): Promise<GrossUpResult> {
  let sourceAmount = args.requiredAmountOut;
  let lastPreview: WithdrawPreviewQuote = {};
  let previewsUsed = 0;

  for (let i = 0; i < args.maxPreviews; i++) {
    previewsUsed++;
    lastPreview = await mcp.callTool<WithdrawPreviewQuote>('withdraw_preview', {
      account: args.account,
      token: args.token,
      amount: sourceAmount.toString(),
      chain: args.chain,
      to: args.to,
    });

    const blocks = blockingPolicyWarnings(lastPreview);
    if (blocks.length) {
      throw new Error(`withdraw_preview policy warnings: ${blocks.join('; ')}`);
    }

    const outRaw = lastPreview.quote?.amount_out;
    if (!outRaw) {
      throw new Error('withdraw_preview missing quote.amount_out');
    }
    const amountOut = BigInt(outRaw);
    const minOut = BigInt(lastPreview.quote?.min_amount_out ?? outRaw);

    if (amountOut >= args.requiredAmountOut) {
      return { sourceAmount, amountOut, minAmountOut: minOut, previewsUsed, lastPreview };
    }

    if (i === args.maxPreviews - 1) {
      throw new Error(
        `gross-up failed after ${args.maxPreviews} previews: need amount_out >= ${args.requiredAmountOut}, got ${amountOut}`,
      );
    }

    // Proportional bump + 2% safety (matches live E2E: 202064 → 212166 for 202064 required out).
    sourceAmount = (sourceAmount * args.requiredAmountOut * 102n) / (amountOut * 100n) + 1n;
  }

  throw new Error('gross-up loop exited unexpectedly');
}

export type OperationStatus = {
  status?: string;
  operation_id?: string;
  details?: {
    evidence?: { destination_tx_hash?: string };
    amount_out?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export async function pollOperationToSuccess(
  mcp: AgentConnectMcp,
  operationId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<OperationStatus> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollMs = options.pollMs ?? 3000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    let op = await mcp.callTool<OperationStatus>('get_operation', { operation_id: operationId });
    const status = (op.status ?? '').toUpperCase();
    if (status === 'SUCCESS') return op;
    if (status === 'FAILED' || status === 'REFUNDED') {
      throw new Error(`withdraw operation ${operationId} ended ${status}: ${JSON.stringify(op)}`);
    }
    if (status === 'UNCERTAIN') {
      op = await mcp.callTool<OperationStatus>('refresh_operation', { operation_id: operationId });
      const s2 = (op.status ?? '').toUpperCase();
      if (s2 === 'SUCCESS') return op;
      if (s2 === 'FAILED' || s2 === 'REFUNDED') {
        throw new Error(`withdraw operation ${operationId} ended ${s2}`);
      }
    }
    await Bun.sleep(pollMs);
  }
  throw new Error(`timed out waiting for operation ${operationId}`);
}

export function extractDestinationTxHash(op: OperationStatus): string {
  const hash =
    op.details?.evidence?.destination_tx_hash ??
    (op.details as { destination_tx_hash?: string } | undefined)?.destination_tx_hash;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`terminal operation missing destination_tx_hash: ${JSON.stringify(op.details)}`);
  }
  return hash;
}
