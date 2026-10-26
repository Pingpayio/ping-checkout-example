/**
 * Minimal Agent Connect MCP client (Streamable HTTP, protocol 2025-03-26).
 * @see https://agent-connect-app-production.up.railway.app/docs/mcp-tools
 */

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class AgentConnectMcp {
  private readonly url: string;
  private readonly bearer: string;
  private sessionId: string | null = null;
  private nextId = 1;
  private protocolVersion = '2025-03-26';

  constructor(mcpUrl: string, bearerToken: string) {
    this.url = mcpUrl.replace(/\/$/, '');
    this.bearer = bearerToken;
  }

  async connect(): Promise<void> {
    const init = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: 'ping-agent-connect-pay-example', version: '0.1.0' },
      },
    });
    if (init.error) {
      throw new Error(`MCP initialize failed: ${init.error.message}`);
    }
    const serverVersion = (init.result as { protocolVersion?: string } | undefined)?.protocolVersion;
    if (serverVersion) this.protocolVersion = serverVersion;

    await this.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (res.error) {
      throw new Error(`MCP tools/call ${name} failed: ${res.error.message}`);
    }
    return parseToolResult<T>(res.result);
  }

  async disconnect(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: this.baseHeaders(),
      });
    } catch {
      // optional
    }
    this.sessionId = null;
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearer}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': this.protocolVersion,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
      headers['MCP-Session-Id'] = this.sessionId;
    }
    return headers;
  }

  private async post(body: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: JSON.stringify(body),
    });

    const session =
      response.headers.get('mcp-session-id') ??
      response.headers.get('Mcp-Session-Id') ??
      response.headers.get('MCP-Session-Id');
    if (session) this.sessionId = session;

    if (response.status === 202) {
      return { jsonrpc: '2.0', id: null, result: null };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    if (contentType.includes('text/event-stream')) {
      const parsed = parseSseJsonRpc(text);
      if (parsed.error) return parsed;
      if (parsed.result !== undefined) return parsed;
      throw new Error(`MCP SSE response had no JSON-RPC result: ${text.slice(0, 300)}`);
    }

    let data: JsonRpcResponse;
    try {
      data = JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new Error(`MCP response was not JSON: ${text.slice(0, 300)}`);
    }
    return data;
  }
}

function parseSseJsonRpc(raw: string): JsonRpcResponse {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  throw new Error('No parseable data: line in MCP SSE stream');
}

function parseToolResult<T>(result: unknown): T {
  const r = result as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  if (r?.isError) {
    const msg = r.content?.map((c) => c.text).filter(Boolean).join('\n') || 'tool error';
    throw new Error(msg);
  }
  const text = r?.content?.find((c) => c.type === 'text')?.text;
  if (!text) {
    return result as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
