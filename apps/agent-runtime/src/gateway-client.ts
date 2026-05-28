import { signGatewayRequest, type ConnectorType } from '@ventus/credentials';
import type { ToolContext, ToolDefinition, ToolExecutor } from './runtime.js';

// Agent-runtime → MCP gateway client.
//
// The gateway is the place where per-tenant connector tokens live and where
// PII scrubbing + audit-before-execute happen. Anything the agent wants to
// do at a real connector (Gmail, Slack, Jira, etc.) goes through here.
//
// Design notes:
//   - The gateway client owns the (toolName → connector) mapping. The agent
//     loop only sees flat tool names — the client decides which connector
//     each one belongs to, signs the request, and parses the response.
//   - The client does NOT wrap audit. The gateway records its own
//     intent+outcome rows; wrapping again at the runtime would double-write
//     and double-count costs. Callers that want gateway-routed tool calls
//     should NOT pass the gateway client's executor through
//     auditedExecutor — let the gateway own the audit boundary for those.
//   - Errors are mapped from HTTP status → typed errors so the agent loop
//     can decide whether to retry. 401/403 are config bugs (re-raise loud);
//     4xx are caller bugs (re-raise); 5xx are upstream bugs (the agent
//     loop's standard tool-error handling applies).
//
// The signing path goes through @ventus/credentials.signGatewayRequest so
// the canonical signing string stays in lock-step with the verifier on the
// gateway side. If either drifts, every request 401s — visible immediately.

export interface ConnectorToolBinding {
  // Flat tool name as the agent sees it (e.g. 'send_email', 'list_recent_documents_email').
  toolName: string;
  connector: ConnectorType;
  // The connector-side tool name. Defaults to toolName when omitted —
  // useful when the agent-facing name differs from what the connector
  // expects (e.g. 'send_email' on the agent → 'messages.send' at Gmail).
  remoteToolName?: string;
  // Optional LLM-facing description + JSON schema. When provided, the
  // run-agent loop can advertise this tool to the model alongside its
  // local tools. When omitted, the binding still routes through the
  // gateway but the caller is responsible for sourcing the schema.
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface GatewayClientOptions {
  // Absolute URL to the gateway, e.g. 'http://localhost:8081'. No trailing slash.
  baseUrl: string;
  // Tenant on whose behalf this client signs. Bound at construction so the
  // signer cannot accidentally sign for the wrong tenant later.
  tenantId: string;
  // Optional fetch override for tests. Defaults to globalThis.fetch.
  fetchImpl?: typeof fetch;
  // Per-call timeout. Defaults to 30s; gateways that forward to slow
  // upstreams (Gmail batch send) may need more.
  timeoutMs?: number;
}

export class GatewayClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GatewayClientError';
  }
}

export interface ToolCallResult {
  intentId: string;
  data: unknown;
  // Pass-through of the gateway's scrub report so the runtime can surface
  // "we redacted N items from this tool call" in its event stream.
  scrub: { counts: Record<string, number>; redacted: boolean };
}

export class GatewayClient {
  private readonly bindings = new Map<string, ConnectorToolBinding>();
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GatewayClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (!this.fetchImpl) {
      throw new Error('GatewayClient: no fetch implementation available');
    }
    if (!opts.baseUrl) throw new Error('GatewayClient: baseUrl required');
    if (!opts.tenantId) throw new Error('GatewayClient: tenantId required');
  }

  registerTool(binding: ConnectorToolBinding): this {
    if (this.bindings.has(binding.toolName)) {
      throw new Error(`tool ${binding.toolName} already registered`);
    }
    this.bindings.set(binding.toolName, binding);
    return this;
  }

  knowsTool(name: string): boolean {
    return this.bindings.has(name);
  }

  toolNames(): string[] {
    return Array.from(this.bindings.keys()).sort();
  }

  // ToolDefinitions for every binding that carries a description + schema.
  // Bindings without those fields are routable but invisible to the model —
  // typically because the schema is sourced elsewhere (e.g. a Skill manifest).
  toolDefinitions(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const b of this.bindings.values()) {
      if (b.description && b.inputSchema) {
        out.push({
          name: b.toolName,
          description: b.description,
          inputSchema: b.inputSchema,
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(name: string, input: unknown, ctx: ToolContext): Promise<ToolCallResult> {
    const binding = this.bindings.get(name);
    if (!binding) {
      throw new Error(`tool not registered on gateway client: ${name}`);
    }
    if (ctx.tenantId !== this.opts.tenantId) {
      // Defence-in-depth. The client is bound to a tenant at construction;
      // a ToolContext that names a different tenant is a runtime bug, not
      // an attack, but we want it to be loud rather than silently signed.
      throw new Error(
        `gateway client bound to tenant ${this.opts.tenantId}, refused to sign for ${ctx.tenantId}`,
      );
    }
    const body = JSON.stringify({
      runId: ctx.runId,
      stepNo: ctx.stepNo,
      connector: binding.connector,
      tool: binding.remoteToolName ?? binding.toolName,
      input,
    });
    const signed = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: this.opts.tenantId,
      body,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/v1/tool-call`, {
        method: 'POST',
        headers: { ...signed, 'content-type': 'application/json' },
        body,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON response (probably HTML from a reverse proxy or an
        // upstream timeout page). Surface the status + raw text via the
        // error rather than throw a JSON parse error.
        throw new GatewayClientError(
          `gateway returned ${res.status} non-JSON`,
          res.status,
          text.slice(0, 256),
        );
      }
    }
    if (!res.ok) {
      const errBody = parsed as { error?: string } | null;
      throw new GatewayClientError(
        errBody?.error ?? `gateway error ${res.status}`,
        res.status,
        parsed,
      );
    }
    const ok = parsed as { ok?: boolean; intentId?: string; data?: unknown; scrub?: unknown };
    if (!ok || ok.ok !== true || typeof ok.intentId !== 'string') {
      throw new GatewayClientError(
        'gateway returned malformed success body',
        res.status,
        parsed,
      );
    }
    const scrub = (ok.scrub as ToolCallResult['scrub'] | undefined) ?? {
      counts: {},
      redacted: false,
    };
    return { intentId: ok.intentId, data: ok.data, scrub };
  }

  // Convenience adapter for the runtime: returns a ToolExecutor that only
  // handles tools registered on this client. Tools not registered throw,
  // which lets a composite dispatcher fall through to a local executor.
  asExecutor(): ToolExecutor {
    return async (name, input, ctx) => {
      const { data } = await this.call(name, input, ctx);
      return data;
    };
  }
}
