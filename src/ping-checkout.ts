export type PingCheckoutMessageType = 'checkout.success' | 'checkout.cancel' | 'checkout.failure';

export interface PingCheckoutMessage {
  source: 'pingpay';
  type: PingCheckoutMessageType;
  sessionId: string;
  paymentId?: string;
}

export interface OpenPingCheckoutOptions {
  sessionUrl: string;
  mode?: 'redirect' | 'popup';
  width?: number;
  height?: number;
  /** Open synchronously from the click handler, before createSession resolves. */
  popup?: Window | null;
  onSuccess?: (message: PingCheckoutMessage) => void;
  onCancel?: (message?: PingCheckoutMessage) => void;
  onFailure?: (message: PingCheckoutMessage) => void;
  onBlocked?: () => void;
}

export interface OpenPingCheckoutResult {
  blocked: boolean;
  fellBackToRedirect: boolean;
  popup: Window | null;
}

export type PopupWatchDecision =
  | { action: 'ignore' }
  | { action: 'success'; message: PingCheckoutMessage }
  | { action: 'failure'; message: PingCheckoutMessage }
  | { action: 'cancel'; message?: PingCheckoutMessage };

export function parseCheckoutSessionId(sessionUrl: string): string | null {
  try {
    return new URL(sessionUrl).searchParams.get('sessionId');
  } catch {
    return null;
  }
}

export function popupWindowFeatures(width: number, height: number): string {
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/**
 * Open a blank popup while the browser still treats the click as a user gesture.
 * Navigate it to sessionUrl after createSession returns.
 */
export function preparePingCheckoutPopup(options?: { width?: number; height?: number }): Window | null {
  const width = options?.width ?? 480;
  const height = options?.height ?? 720;
  const name = `ping-checkout-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return window.open('about:blank', name, popupWindowFeatures(width, height));
}

/**
 * A payment result arrives as a postMessage while the popup is still open.
 * Cancel is the popup closing before that message. The page is already gone,
 * so cancel has no payload.
 */
export function nextPopupWatch(input: {
  settled: boolean;
  popupClosed: boolean;
  message?: unknown;
  fromPopup: boolean;
  originMatches: boolean;
  expectedSessionId: string;
}): PopupWatchDecision {
  if (input.settled) return { action: 'ignore' };

  if (input.message !== undefined) {
    if (!input.fromPopup || !input.originMatches || !isPingMessage(input.message)) {
      return { action: 'ignore' };
    }
    if (input.message.sessionId !== input.expectedSessionId) {
      return { action: 'ignore' };
    }
    if (input.message.type === 'checkout.success') return { action: 'success', message: input.message };
    if (input.message.type === 'checkout.failure') return { action: 'failure', message: input.message };
    return { action: 'cancel', message: input.message };
  }

  if (input.popupClosed) return { action: 'cancel' };
  return { action: 'ignore' };
}

function isPingMessage(data: unknown): data is PingCheckoutMessage {
  if (!data || typeof data !== 'object') return false;
  const message = data as Partial<PingCheckoutMessage>;
  return (
    message.source === 'pingpay' &&
    (message.type === 'checkout.success' ||
      message.type === 'checkout.cancel' ||
      message.type === 'checkout.failure') &&
    typeof message.sessionId === 'string' &&
    message.sessionId.length > 0
  );
}

function watchPingCheckoutPopup(
  popup: Window,
  sessionUrl: string,
  expectedSessionId: string,
  options: Pick<OpenPingCheckoutOptions, 'onSuccess' | 'onCancel' | 'onFailure'>
): void {
  const pingOrigin = new URL(sessionUrl).origin;
  let settled = false;

  const finish = () => {
    settled = true;
    window.removeEventListener('message', onMessage);
    window.clearInterval(closedTimer);
  };

  const applyDecision = (decision: PopupWatchDecision) => {
    if (decision.action === 'ignore') return;
    finish();
    if (decision.action === 'success') options.onSuccess?.(decision.message);
    else if (decision.action === 'failure') options.onFailure?.(decision.message);
    else options.onCancel?.(decision.message);
  };

  const onMessage = (event: MessageEvent) => {
    applyDecision(nextPopupWatch({
      settled,
      popupClosed: false,
      message: event.data,
      fromPopup: event.source === popup,
      originMatches: event.origin === pingOrigin,
      expectedSessionId,
    }));
  };

  const closedTimer = window.setInterval(() => {
    applyDecision(nextPopupWatch({
      settled,
      popupClosed: popup.closed,
      fromPopup: false,
      originMatches: false,
      expectedSessionId,
    }));
  }, 400);

  window.addEventListener('message', onMessage);
}

/**
 * Opens Ping checkout. Popup mode keeps the merchant page open and listens for
 * a postMessage from the Ping origin. If the browser blocks the popup, this
 * falls back to a full-page redirect.
 *
 * Do not pass noopener: the checkout window needs window.opener to report back.
 * payerAccountId is not a login. Wallet approval still happens inside Ping.
 */
export function openPingCheckout(options: OpenPingCheckoutOptions): OpenPingCheckoutResult {
  const mode = options.mode ?? 'redirect';
  if (mode !== 'popup') {
    window.location.assign(options.sessionUrl);
    return { blocked: false, fellBackToRedirect: false, popup: null };
  }

  const expectedSessionId = parseCheckoutSessionId(options.sessionUrl);
  if (!expectedSessionId) {
    window.location.assign(options.sessionUrl);
    return { blocked: false, fellBackToRedirect: true, popup: null };
  }

  const width = options.width ?? 480;
  const height = options.height ?? 720;
  let popup = options.popup ?? null;

  if (!popup) {
    popup = window.open(
      options.sessionUrl,
      `ping-checkout-${expectedSessionId}`,
      popupWindowFeatures(width, height)
    );
  } else {
    popup.location.assign(options.sessionUrl);
  }

  if (!popup) {
    options.onBlocked?.();
    window.location.assign(options.sessionUrl);
    return { blocked: true, fellBackToRedirect: true, popup: null };
  }

  watchPingCheckoutPopup(popup, options.sessionUrl, expectedSessionId, options);
  return { blocked: false, fellBackToRedirect: false, popup };
}
