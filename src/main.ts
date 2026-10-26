import { openPingCheckout, preparePingCheckoutPopup } from './ping-checkout';

type CheckoutFeeType = 'royalty' | 'platform' | 'affiliate' | 'service' | 'custom';

interface CheckoutFee {
  type: CheckoutFeeType;
  label: string;
  recipient: string;
  bps: number; // basis points: 100 = 1%, 500 = 5%
}

interface CreateCheckoutSessionInput {
  amount: string;
  asset: {
    chain: string;
    symbol: string;
  };
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, unknown>;
  fees?: CheckoutFee[];
  /** Confidential swap on/off; defaults to on. Pass false for a public swap. */
  confidential?: boolean;
  /** Enabled checkout methods. Omitted → wallet, deposit, and card. */
  paymentMethods?: Array<'wallet' | 'card' | 'deposit'>;
  /** Merchant-scoped customer org key for payment list filters. */
  customerReference?: string;
  /** redirect (default) leaves the merchant page. popup keeps it open. */
  displayMode?: 'redirect' | 'popup';
  /** NEAR account hint only. Does not sign the payer in. */
  payerAccountId?: string;
  /** Origin allowed to receive checkout postMessage events. */
  merchantOrigin?: string;
}

interface CreateCheckoutSessionResponse {
  session: {
    sessionId: string;
    status: string;
    amount: string;
    recipient: string;
    asset: {
      chain: string;
      symbol: string;
    }
    createdAt: string;
    expiresAt?: string;
    fees?: CheckoutFee[];
  };
  sessionUrl: string;
}

async function createCheckoutSession(
  apiUrl: string,
  input: CreateCheckoutSessionInput
): Promise<CreateCheckoutSessionResponse> {
  // This demo uses the OpenAPI/REST handler mounted under `/api`.
  // (The checkout UI uses oRPC under `/api/rpc`.)
  const baseUrl = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
  // @ts-ignore - Vite provides import.meta.env at runtime
  const apiKey = import.meta.env.VITE_API_KEY || '';
  const response = await fetch(`${baseUrl}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to create session' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

function showError(message: string) {
  const errorDiv = document.getElementById('errorMessages');
  if (!errorDiv) return;
  errorDiv.textContent = message;
  errorDiv.style.display = message ? 'block' : 'none';
}

function showLoading(button: HTMLButtonElement) {
  button.disabled = true;
  button.dataset.originalHtml ??= button.innerHTML;
  button.innerHTML = '<span class="loading"></span> Creating session...';
}

function hideLoading(button: HTMLButtonElement) {
  button.disabled = false;
  button.innerHTML = button.dataset.originalHtml || button.innerHTML;
}

/**
 * Parse callback parameters from URL query string
 */
function parseCallbackParams(): {
  paymentId?: string;
  sessionId?: string;
  txStatus?: string;
  depositAddress?: string;
} | null {
  const urlParams = new URLSearchParams(window.location.search);
  const paymentId = urlParams.get('paymentId');
  const sessionId = urlParams.get('sessionId');
  const txStatus = urlParams.get('txStatus');
  const depositAddress = urlParams.get('depositAddress');

  if (paymentId || sessionId || txStatus) {
    return {
      paymentId: paymentId || undefined,
      sessionId: sessionId || undefined,
      txStatus: txStatus || undefined,
      depositAddress: depositAddress || undefined,
    };
  }

  return null;
}

/**
 * Display callback result page with order status
 */
function showCallbackResult(params: {
  paymentId?: string;
  sessionId?: string;
  txStatus?: string;
  depositAddress?: string;
}) {
  const app = document.getElementById('app');
  if (!app) return;

  const isSuccess = params.txStatus === 'SUCCESS';
  const isFailed = params.txStatus === 'FAILED';
  const isRefunded = params.txStatus === 'REFUNDED';

  let orderStatus = '';
  let orderMessage = '';
  let iconColor = '#ab9ff2';
  let icon = '✓';
  
  if (isSuccess) {
    orderStatus = 'Payment Successful!';
    orderMessage = 'Thank you for your purchase! Your payment was successful.';
    iconColor = '#28a745';
    icon = '✓';
  } else if (isRefunded) {
    orderStatus = 'Payment Refunded';
    orderMessage = 'Your payment has been refunded. You will receive your funds back shortly.';
    iconColor = '#dc3545';
    icon = '↩';
  } else if (isFailed) {
    orderStatus = 'Payment Failed';
    orderMessage = 'The payment was not completed. Please try again.';
    iconColor = '#dc3545';
    icon = '✗';
  } else {
    orderStatus = `Payment Status: ${params.txStatus || 'Unknown'}`;
    orderMessage = 'Your payment is being processed.';
  }

  const callbackHtml = `
    <div class="callback-container">
      <div class="callback-icon" style="color: ${iconColor};">
        ${icon}
      </div>
      <h1 class="callback-title" style="color: ${iconColor};">
        ${orderStatus}
      </h1>
      <p class="callback-message">
        ${orderMessage}
      </p>
      <div class="callback-details">
        <h3>Payment Details</h3>
        <div>
          ${params.paymentId ? `<div><strong>Payment ID:</strong> <code>${params.paymentId}</code></div>` : ''}
          ${params.sessionId ? `<div><strong>Session ID:</strong> <code>${params.sessionId}</code></div>` : ''}
          ${params.txStatus ? `<div><strong>Payment Status:</strong> <span style="font-weight: 600; text-transform: uppercase;">${params.txStatus}</span></div>` : ''}
          ${params.depositAddress ? `<div><strong>Transaction:</strong> <code>${params.depositAddress}</code></div>` : ''}
        </div>
        <div class="note">
          <p style="margin-bottom: 8px;"><strong>Note:</strong> Save these IDs for your records. You can use them to query Ping's API for payment details and audit purposes.</p>
          ${params.depositAddress ? `<p>View transaction on <a href="https://explorer.near-intents.org/transactions/${params.depositAddress}" target="_blank">Intents Explorer ↗</a></p>` : ''}
        </div>
      </div>
      <button type="button" onclick="window.location.href = window.location.pathname" class="callback-button">
        ${isSuccess ? 'Continue Shopping' : 'Try Again'}
      </button>
    </div>
  `;

  app.innerHTML = callbackHtml;
}

document.addEventListener('DOMContentLoaded', () => {
  // Check if this is a callback from payment completion
  const callbackParams = parseCallbackParams();
  if (callbackParams) {
    showCallbackResult(callbackParams);
    return;
  }

  // Otherwise, show the normal checkout flow
  const checkoutButton = document.getElementById('openCheckoutButton') as HTMLButtonElement;
  // In Vite, use import.meta.env and prefix env vars with VITE_
  // @ts-ignore - Vite provides import.meta.env at runtime
  const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
  const apiUrl = baseUrl + '/api';

  // Build callback URLs pointing back to this page
  const currentUrl = new URL(window.location.href);
  const successUrl = `${currentUrl.origin}${currentUrl.pathname}?callback=success`;
  const cancelUrl = `${currentUrl.origin}${currentUrl.pathname}?callback=cancel`;

  checkoutButton.addEventListener('click', async () => {
    await startCheckout(checkoutButton);
  });

  document.querySelectorAll<HTMLButtonElement>('[data-checkout-methods], [data-display-mode]').forEach((button) => {
    button.addEventListener('click', async () => {
      const raw = button.dataset.checkoutMethods ?? '';
      const paymentMethods = raw
        ? (raw.split(',').map((method) => method.trim()) as Array<'wallet' | 'card' | 'deposit'>)
        : undefined;
      const displayMode = button.dataset.displayMode === 'popup' ? 'popup' : 'redirect';
      await startCheckout(button, paymentMethods, displayMode);
    });
  });

  function showCheckoutStatus(message: string) {
    const status = document.getElementById('checkoutStatus');
    if (!status) return;
    status.textContent = message;
    status.style.display = 'block';
  }

  async function startCheckout(
    button: HTMLButtonElement,
    paymentMethods?: Array<'wallet' | 'card' | 'deposit'>,
    displayMode: 'redirect' | 'popup' = 'redirect'
  ) {
    showLoading(button);
    showError('');

    const popup = displayMode === 'popup' ? preparePingCheckoutPopup() : null;
    if (displayMode === 'popup' && !popup) {
      showCheckoutStatus('Popup blocked. Continuing in this tab.');
    }

    try {
      const orderId = `order_${Date.now()}`;
      const input: CreateCheckoutSessionInput = {
        amount: '2000000',
        asset: {
          chain: 'NEAR',
          symbol: 'USDC',
        },
        successUrl: successUrl,
        cancelUrl: cancelUrl,
        customerReference: 'merchant-demo',
        displayMode,
        merchantOrigin: displayMode === 'popup' ? currentUrl.origin : undefined,
        metadata: {
          orderId: orderId,
          productName: 'NEAR Merch T-Shirt',
          customerEmail: 'demo@example.com',
          paymentMethodsPreview: paymentMethods?.join(',') || 'default',
        },
        paymentMethods,
      };

      const response = await createCheckoutSession(apiUrl, input);
      const opened = openPingCheckout({
        sessionUrl: response.sessionUrl,
        mode: displayMode,
        popup,
        onSuccess: (message) => {
          showCheckoutStatus(`Payment succeeded (${message.paymentId ?? message.sessionId}).`);
        },
        onFailure: (message) => {
          showCheckoutStatus(`Payment failed (${message.sessionId}).`);
          hideLoading(button);
        },
        onCancel: () => {
          showCheckoutStatus('Checkout closed.');
          hideLoading(button);
        },
        onBlocked: () => {
          showCheckoutStatus('Popup blocked. Continuing in this tab.');
        },
      });
      if (opened.blocked || displayMode === 'redirect') return;
      hideLoading(button);
    } catch (error) {
      popup?.close();
      console.error('Error creating checkout session:', error);
      showError(
        `Failed to create checkout session: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      hideLoading(button);
    }
  }
});
