const X402_VERSION = 2;
const X402_SCHEME = 'exact';
const X402_NETWORK = 'eip155:8453';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;

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

export async function prepareChallenge(
  baseUrl: string,
  apiKey: string,
  amountOutHuman: string,
): Promise<PreparedChallenge> {
  const amountOut = amountOutFromHuman(amountOutHuman);
  const body = await requestJson('prepare', `${baseUrl}/agentpay/x402/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      amountOut,
      challengeIdentity: 'agent-connect-pay-example',
      pricingMode: 'fixed',
      description: 'Agent Connect MCP payer example',
    }),
  });
  const prepared = body as PreparedChallenge;
  if (!prepared.payTo || !prepared.amount) {
    throw new Error('prepare response missing payTo/amount');
  }
  return prepared;
}

export function assertPayableChallenge(prepared: PreparedChallenge) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(prepared.payTo)) {
    throw new Error(`prepare payTo is not a Base address: ${prepared.payTo}`);
  }
  if (prepared.network !== X402_NETWORK || prepared.asset.toLowerCase() !== USDC_BASE.toLowerCase()) {
    throw new Error(`unexpected network/asset: ${prepared.network} / ${prepared.asset}`);
  }
}

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
