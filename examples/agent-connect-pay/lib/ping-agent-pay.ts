const X402_VERSION = 2;
const X402_SCHEME = 'exact';
const X402_NETWORK = 'eip155:8453';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;

export const CHALLENGE_IDENTITY = 'agent-connect-pay-example';

export type PreparedChallenge = {
  payTo: string;
  amount: string;
  asset: string;
  network: string;
  scheme: string;
  minAmountIn: string;
  amountOut: string;
  refundTo: string;
  expiresAt: string;
  maxTimeoutSeconds: number;
  agentPayChallengeId: string;
  [key: string]: unknown;
};

export type UnquotedAccept = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: {
    assetTransferMethod?: string;
    paymentFlow?: string;
    destination?: {
      network: string;
      asset: string;
      amount: string;
      recipient: string;
    };
    [key: string]: unknown;
  };
};

export type QuotedChallenge = {
  depositAddress: string;
  /** 1Click origin deposit (verify `extra.amountIn`) — may use non–6-decimal units; do not pass raw to MCP. */
  amountIn: string;
  operationToken: string;
  refundDeadline?: string;
  depositMemo?: string;
  maxTimeoutSeconds: number;
  /** Merchant destination amount (USDC 6-decimal base units from offers / TEST_AMOUNT_USDC). */
  amountOut: string;
  /**
   * Base-chain delivery target at withdraw `to` for MCP gross-up (same role as legacy `prepare.amount`
   * when that field was Base-sized USDC atoms).
   */
  requiredBaseDelivery: string;
  /** Unquoted accept entry — reused as `accepted` on deposit settle (PR 3370). */
  unquotedAccept: UnquotedAccept;
  /** Quote-phase paymentPayload (resource + accepted + quote payload). */
  quotePaymentPayload: Record<string, unknown>;
};

/** ~1M USDC in 6-decimal atoms — reject 1Click amountIn values that cannot be MCP preview amounts. */
const MAX_SANE_USDC_ATOMIC = 10n ** 12n;

function isBaseOriginAccept(accept: UnquotedAccept): boolean {
  return accept.network === X402_NETWORK || accept.network.startsWith('eip155:8453');
}

/**
 * MCP `withdraw_preview` / gross-up target: USDC atoms that must arrive at the Base deposit `to`.
 * Uses verify `amountIn` only when origin is Base and the value looks like 6-decimal USDC;
 * otherwise uses merchant `amountOut` (same sizing as TEST_AMOUNT_USDC / legacy prepare.amount on staging).
 */
export function deriveRequiredBaseDelivery(quoted: Pick<QuotedChallenge, 'amountIn' | 'amountOut' | 'unquotedAccept'>): string {
  const amountOut = BigInt(quoted.amountOut);
  const amountIn = BigInt(quoted.amountIn);
  if (amountOut <= 0n) {
    throw new Error(`amountOut must be > 0, got ${quoted.amountOut}`);
  }
  if (amountOut > MAX_SANE_USDC_ATOMIC) {
    throw new Error(`amountOut out of range for USDC 6-decimal sizing: ${quoted.amountOut}`);
  }

  if (isBaseOriginAccept(quoted.unquotedAccept) && amountIn > 0n && amountIn <= MAX_SANE_USDC_ATOMIC) {
    return amountIn.toString();
  }

  return amountOut.toString();
}

export function amountOutFromHuman(human: string): string {
  if (!/^\d+(\.\d+)?$/.test(human)) {
    throw new Error(`TEST_AMOUNT_USDC must be a decimal like "0.2", got "${human}"`);
  }
  const [whole = '0', fracRaw = ''] = human.split('.');
  const frac = (fracRaw + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const atomic = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac || '0');
  if (atomic <= 0n) throw new Error('TEST_AMOUNT_USDC must be > 0');
  return atomic.toString();
}

export function formatUsdc(atomic: string): string {
  const n = BigInt(atomic);
  const whole = n / 10n ** BigInt(USDC_DECIMALS);
  const frac = (n % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Ping / 1Click deposit target: NEAR intents id or origin-chain hex (staging often returns Base EVM hex). */
export function isAgentPayDepositAddress(value: string): boolean {
  const v = value.trim();
  if (/^deposit_agentpay_/.test(v)) return true;
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return true;
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return true;
  if (/^[0-9a-fA-F]{40}$/.test(v)) return true;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return true;
  return false;
}

/**
 * Agent Connect `withdraw` / `withdraw_preview` `to` on `chain: base`.
 * Staging verify may return a 32-byte hex string; Base delivery uses the trailing 20-byte EVM address.
 */
export function withdrawToForBaseChain(depositAddress: string): string {
  const v = depositAddress.trim();
  if (/^deposit_agentpay_/.test(v)) return v;
  if (/^0x[0-9a-fA-F]{40}$/i.test(v)) return v;
  if (/^[0-9a-fA-F]{40}$/i.test(v)) return `0x${v}`;
  if (/^0x[0-9a-fA-F]{64}$/i.test(v)) return `0x${v.slice(-40)}`;
  if (/^[0-9a-fA-F]{64}$/i.test(v)) return `0x${v.slice(-40)}`;
  throw new Error(`deposit address is not a recognized Ping deposit target: ${depositAddress}`);
}

function buildRequirements(prepared: PreparedChallenge) {
  return {
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    asset: USDC_BASE,
    amount: prepared.amount,
    payTo: prepared.payTo,
    maxTimeoutSeconds: prepared.maxTimeoutSeconds,
    extra: {},
  };
}

function buildPaymentPayload(txHash: string, prepared: PreparedChallenge) {
  const requirements = buildRequirements(prepared);
  return { x402Version: X402_VERSION, accepted: requirements, payload: { txHash } };
}

function paymentRequirementsFromAccept(accept: UnquotedAccept) {
  return {
    ...accept,
    extra: {
      ...(accept.extra ?? {}),
      assetTransferMethod: accept.extra?.assetTransferMethod ?? 'near-intents',
      paymentFlow: accept.extra?.paymentFlow ?? 'upfront',
    },
  };
}

async function requestJson(label: string, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  if (!response.ok) {
    throw new Error(
      `${label} HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}`,
    );
  }
  return body;
}

export async function getSupported(baseUrl: string): Promise<unknown> {
  return requestJson('supported', `${baseUrl}/agentpay/x402/supported`, { method: 'GET' });
}

export async function fetchOffers(
  baseUrl: string,
  apiKey: string,
  amountOutHuman: string,
  description?: string,
): Promise<{ accepts: UnquotedAccept[]; resource?: unknown }> {
  const amountOut = amountOutFromHuman(amountOutHuman);
  const url = new URL(`${baseUrl}/agentpay/x402/offers`);
  url.searchParams.set('amountOut', amountOut);
  const body = (await requestJson('offers', url.toString(), {
    method: 'GET',
    headers: { 'x-api-key': apiKey },
  })) as { accepts?: UnquotedAccept[]; resource?: unknown };
  const accepts = body.accepts ?? [];
  if (!accepts.length) {
    throw new Error('offers returned no accepts');
  }
  if (description && body.resource && typeof body.resource === 'object') {
    (body.resource as Record<string, unknown>).description = description;
  }
  return { accepts, resource: body.resource };
}

export function pickBaseAccept(accepts: UnquotedAccept[]): UnquotedAccept {
  const match =
    accepts.find((entry) => entry.network === X402_NETWORK) ??
    accepts.find((entry) => entry.network?.startsWith('eip155:8453'));
  if (!match) {
    throw new Error(`offers missing Base accept (${X402_NETWORK}); got ${accepts.map((a) => a.network).join(', ')}`);
  }
  return match;
}

export async function mintQuoteViaVerify(
  baseUrl: string,
  apiKey: string,
  args: {
    refundTo: string;
    amountOutHuman: string;
    description?: string;
    resourceUrl?: string;
  },
): Promise<QuotedChallenge> {
  const { accepts } = await fetchOffers(baseUrl, apiKey, args.amountOutHuman, args.description);
  const unquotedAccept = pickBaseAccept(accepts);
  const amountOut =
    unquotedAccept.extra?.destination?.amount ?? amountOutFromHuman(args.amountOutHuman);
  const resourceUrl = args.resourceUrl ?? CHALLENGE_IDENTITY;
  const quotePaymentPayload = {
    x402Version: X402_VERSION,
    resource: { url: resourceUrl, description: args.description },
    accepted: unquotedAccept,
    payload: {
      type: 'quote',
      refundTo: args.refundTo,
      originAsset: unquotedAccept.asset,
    },
  };
  const paymentRequirements = paymentRequirementsFromAccept(unquotedAccept);

  const verify = (await requestJson('verify (quote)', `${baseUrl}/agentpay/x402/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      x402Version: X402_VERSION,
      paymentPayload: quotePaymentPayload,
      paymentRequirements,
    }),
  })) as {
    isValid?: boolean;
    invalidReason?: string;
    invalidMessage?: string;
    extra?: {
      depositAddress?: string;
      amountIn?: string;
      operationToken?: string;
      refundDeadline?: string;
      depositMemo?: string;
    };
  };

  if (!verify.isValid) {
    throw new Error(
      `verify quote failed: ${verify.invalidReason ?? 'unknown'} — ${verify.invalidMessage ?? JSON.stringify(verify)}`,
    );
  }
  const extra = verify.extra ?? {};
  const depositAddress = extra.depositAddress?.trim() ?? '';
  const amountIn = extra.amountIn?.trim() ?? '';
  const operationToken = extra.operationToken?.trim() ?? '';
  if (!depositAddress || !amountIn || !operationToken) {
    throw new Error(`verify quote missing depositAddress/amountIn/operationToken: ${JSON.stringify(verify)}`);
  }

  const partial = {
    depositAddress,
    amountIn,
    operationToken,
    refundDeadline: extra.refundDeadline,
    depositMemo: extra.depositMemo,
    maxTimeoutSeconds: unquotedAccept.maxTimeoutSeconds,
    amountOut,
    unquotedAccept,
    quotePaymentPayload,
  };
  const requiredBaseDelivery = deriveRequiredBaseDelivery(partial);

  return { ...partial, requiredBaseDelivery };
}

export async function prepareChallenge(
  baseUrl: string,
  apiKey: string,
  amountOutHuman: string,
  refundAddress?: string,
): Promise<PreparedChallenge> {
  const amountOut = amountOutFromHuman(amountOutHuman);
  const body = await requestJson('prepare', `${baseUrl}/agentpay/x402/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      amountOut,
      challengeIdentity: CHALLENGE_IDENTITY,
      pricingMode: 'fixed',
      description: 'Agent Connect MCP payer example',
      ...(refundAddress ? { refundAddress } : {}),
    }),
  });
  const prepared = body as PreparedChallenge;
  if (!prepared.payTo || !prepared.amount) {
    throw new Error('prepare response missing payTo/amount');
  }
  return prepared;
}

export function assertPayableChallenge(prepared: PreparedChallenge) {
  if (!isAgentPayDepositAddress(prepared.payTo)) {
    throw new Error(`prepare payTo is not a recognized deposit address: ${prepared.payTo}`);
  }
  if (prepared.network !== X402_NETWORK || prepared.asset.toLowerCase() !== USDC_BASE.toLowerCase()) {
    throw new Error(`unexpected network/asset: ${prepared.network} / ${prepared.asset}`);
  }
}

export function assertQuotedChallenge(quoted: QuotedChallenge) {
  if (!isAgentPayDepositAddress(quoted.depositAddress)) {
    throw new Error(`quoted depositAddress is not a recognized deposit target: ${quoted.depositAddress}`);
  }
  if (!/^\d+$/.test(quoted.amountIn)) {
    throw new Error(`quoted amountIn must be base units: ${quoted.amountIn}`);
  }
}

export async function settleDeposit(
  baseUrl: string,
  apiKey: string,
  quoted: QuotedChallenge,
  txHash: string,
): Promise<{ settle: unknown }> {
  const paymentRequirements = paymentRequirementsFromAccept(quoted.unquotedAccept);
  const depositPaymentPayload = {
    ...quoted.quotePaymentPayload,
    payload: {
      type: 'deposit',
      operationToken: quoted.operationToken,
      depositAddress: quoted.depositAddress,
      txHash,
      ...(quoted.depositMemo ? { depositMemo: quoted.depositMemo } : {}),
    },
  };

  const settle = await requestJson('settle (deposit)', `${baseUrl}/agentpay/x402/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      x402Version: X402_VERSION,
      paymentPayload: depositPaymentPayload,
      paymentRequirements,
    }),
  });

  return { settle };
}

/** Legacy txHash-only verify + settle after prepare (compat). */
export async function verifyAndSettle(
  baseUrl: string,
  apiKey: string,
  txHash: string,
  prepared: PreparedChallenge,
): Promise<{ verify: unknown; settle: unknown }> {
  const requirements = buildRequirements(prepared);
  const paymentPayload = buildPaymentPayload(txHash, prepared);

  const verify = await requestJson('verify', `${baseUrl}/agentpay/x402/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: requirements,
    }),
  });

  const settle = await requestJson('settle', `${baseUrl}/agentpay/x402/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: requirements,
    }),
  });

  return { verify, settle };
}
