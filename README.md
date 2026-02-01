# PingPay Checkout Merchant Demo

This is an example merchant application demonstrating how to integrate PingPay Checkout into your application.

## How It Works

1. **Create a Checkout Session**: Call the `POST /checkout/sessions` API endpoint with payment details
2. **Get Session URL**: The API returns a `sessionUrl` that you can redirect users to
3. **User Completes Payment**: The user is redirected to the checkout page where they:
   - Connect their NEAR wallet
   - Review payment details
   - Complete the payment
4. **Redirect Back**: After payment completion, the user is redirected to your `successUrl` or `cancelUrl`

## Configuration

Before running the demo, you need to set up environment variables. Create a `.env` file in the root directory:

```bash
VITE_API_URL=https://pay.pingpay.io
VITE_API_KEY=your_api_key_here
```

You can get your API key from your [PingPay dashboard](https://pay.pingpay.io/dashboard).

**Note:** The recipient address must be configured in your organization settings on the PingPay dashboard.

## Running the Demo

1. Install dependencies:
```bash
bun install
```

2. Set up your environment variables (see Configuration section above)

3. Start the development server:
```bash
bun run dev
```

4. Open the app in your browser (usually `http://localhost:5173`)

5. Click "Pay with Ping" to create a checkout session and redirect to the payment page

## API Integration Example

```typescript
const response = await fetch('https://pay.pingpay.io/api/checkout/sessions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY', // Get this from your PingPay dashboard
  },
  body: JSON.stringify({
    amount: '1000000', // 1 USDC (6 decimals: 1 * 10^6 = 1000000) - string in smallest units
    asset: {
      chain: 'NEAR',
      symbol: 'USDC', // API will resolve this to assetId automatically
    },
    successUrl: 'https://yoursite.com/success',
    cancelUrl: 'https://yoursite.com/cancel',
    metadata: {
      orderId: 'order_123',
      productName: 'Product Name',
      customerEmail: 'customer@example.com',
    },
  }),
});

const { sessionUrl, session } = await response.json();

// Redirect user to checkout page
window.location.href = sessionUrl;
```

**Important:** 
- All API requests require the `x-api-key` header with your API key
- The recipient address is configured in your organization settings, not in the checkout session request
- The API URL is `https://pay.pingpay.io/api`

## Checkout URL Format

The checkout URL format is:
```
https://pay.pingpay.io/checkout?sessionId={sessionId}
```

Or for local development:
```
http://localhost:5173/checkout?sessionId={sessionId}
```

## Notes

- Make sure you have set up your `VITE_API_KEY` environment variable
- The API URL is `https://pay.pingpay.io/api`
- The checkout page requires users to connect their NEAR wallet
- Payments are processed through NEAR intents for cross-chain compatibility
- The session expires after 1 hour by default
- The recipient address is configured in your organization settings on the PingPay dashboard

