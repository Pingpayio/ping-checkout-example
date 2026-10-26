# PingPay Checkout Examples

This repository contains two related examples:

| Path | What it demonstrates |
|------|----------------------|
| **Repository root** | Hosted **merchant checkout** — create a session via REST, redirect or open a popup, handle success/cancel callbacks |
| **`examples/agent-connect-pay/`** | **Agent payer** staging script — an [Agent Connect](https://agent-connect-app-production.up.railway.app/docs/overview) MCP wallet pays a Ping Agent Pay x402 challenge on staging |

---

## Merchant hosted checkout (root)

Example merchant application showing how to integrate PingPay Checkout into your site.

### How it works

1. **Create a checkout session** — `POST /checkout/sessions` with payment details
2. **Get `sessionUrl`** — redirect the shopper or open it in a popup
3. **User completes payment** — wallet, card, or deposit on Ping’s checkout page
4. **Return to your site** — full-page redirect to `successUrl` / `cancelUrl`, or `postMessage` when using popup mode

### Configuration

Create a `.env` file in the repository root:

```bash
VITE_API_URL=https://pay.pingpay.io
VITE_API_KEY=your_api_key_here
```

Get your API key from the [PingPay dashboard](https://pay.pingpay.io/dashboard). The **recipient** address is configured in your organization settings, not in the session request.

### Running the demo

```bash
bun install
bun run dev
```

Open the app (usually `http://localhost:5173`). Use **Pay with Ping** for the default flow, **Wallet only** to pass `paymentMethods: ['wallet']`, or **Pay in a popup** for `displayMode: 'popup'`.

Build for production:

```bash
bun run build
```

### API integration example

```typescript
const response = await fetch('https://pay.pingpay.io/api/checkout/sessions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY',
  },
  body: JSON.stringify({
    amount: '1000000', // 1 USDC (6 decimals) — string in smallest units
    asset: {
      chain: 'NEAR',
      symbol: 'USDC', // API resolves to assetId automatically
    },
    successUrl: 'https://yoursite.com/success',
    cancelUrl: 'https://yoursite.com/cancel',
    customerReference: 'my-store', // optional; filter payments in the dashboard
    // Omit paymentMethods to offer wallet, card, and deposit.
    paymentMethods: ['wallet'], // example: skip picker, wallet only
    fees: [
      {
        type: 'royalty',
        label: 'Creator',
        recipient: 'creator.near',
        bps: 500, // 5.00%
      },
    ],
  }),
});

const { sessionUrl, session } = await response.json();
window.location.href = sessionUrl;
```

### Popup checkout

`displayMode` defaults to `redirect`. Set it to `popup` to keep the shopper on your page. `sessionUrl` is the same either way.

```typescript
displayMode: 'popup',
merchantOrigin: 'https://yoursite.com', // origin only; derived from successUrl when omitted
payerAccountId: 'alice.near', // optional hint, not a signer
```

Open the popup synchronously from the click handler, then navigate it after `createSession` returns. Use `src/ping-checkout.ts`:

```typescript
const popup = preparePingCheckoutPopup();
const { sessionUrl } = await createSession(...);
openPingCheckout({
  sessionUrl,
  mode: 'popup',
  popup,
  onSuccess: (message) => {}, // { source: 'pingpay', type: 'checkout.success', sessionId, paymentId? }
  onCancel: () => {},
  onFailure: (message) => {},
});
```

Ping posts `{ source: 'pingpay', type: 'checkout.success' | 'checkout.failure', sessionId, paymentId? }` to `merchantOrigin` and then closes the popup. Cancel is the shopper closing the window before a result — there is no `checkout.cancel` payload. If the browser blocks the popup, the helper redirects this tab and calls `onBlocked`.

Do not pass `noopener` to `window.open`. Checkout needs `window.opener` to report the result.

Card payments navigate inside the popup (Ping → Coinbase → Ping). They should not open a second window.

#### NEAR login is not shared

Ping checkout runs on Ping’s origin, so it cannot read a Wallet Selector session on your site. `payerAccountId` is a label inside checkout (“Suggested account alice.near”). It does not select the wallet or sign anything. The payer still connects and approves from the Ping window.

### Fees (optional)

The `fees` parameter adds per-checkout splits for royalties, affiliates, or partners:

```typescript
fees: [
  {
    type: 'royalty', // 'royalty' | 'platform' | 'affiliate' | 'service' | 'custom'
    label: 'Creator Royalty',
    recipient: 'creator.near',
    bps: 500, // 100 = 1%, 500 = 5%
  },
]
```

- `fees` is optional
- `recipient` must be a valid NEAR account ID
- Ping adds its own platform fee automatically (0.5%)
- Total includes Ping fee + dashboard merchant fees + request fees
- Duplicate recipients are merged and their `bps` values are summed

### Checkout URL format

```
https://pay.pingpay.io/checkout?sessionId={sessionId}
```

Local development (when running Ping’s checkout UI locally):

```
http://localhost:5173/checkout?sessionId={sessionId}
```

### Notes

- All API requests require the `x-api-key` header
- Sessions expire after about one hour by default
- Payments use NEAR Intents for cross-chain compatibility

---

## Agent Connect payer (`examples/agent-connect-pay`)

Standalone Bun example: an **Agent Connect MCP** wallet pays a **Ping Agent Pay** x402 challenge on staging.

Flow: Ping `prepare` → gross-up `withdraw_preview` → `withdraw` → poll `get_operation` for `destination_tx_hash` → Ping `verify` / `settle`.

See [`examples/agent-connect-pay/README.md`](examples/agent-connect-pay/README.md) for setup (Agent Connect API key, staging Ping API key, env vars) and commands:

```bash
cd examples/agent-connect-pay
bun install
bun run check                 # read-only preflight
bun run pay -- --confirm      # real withdraw + verify/settle (Base mainnet)
```

This is example glue only — not production payer infrastructure.
