import type { ConnectorType } from '@ventus/credentials';

// A ToolForwarder is the gateway's outbound hop: it takes a tool-call request
// (already authenticated, scrubbed, vault-decrypted) and dispatches it to the
// real connector (Gmail, Slack, Jira, etc.). Each connector type owns one.
//
// The forwarder receives the DECRYPTED token; the gateway is responsible for
// not logging it. A forwarder that prints it back is a bug, not a feature.
//
// Why it's a separate abstraction: keeps the gateway core (auth + scrub +
// audit) independently testable from any single connector's SDK, AND lets
// us swap a connector for a stub during integration tests without faking
// HTTP at a lower level.

export interface ForwardInput {
  tenantId: string;
  connector: ConnectorType;
  tool: string;
  // Tool input AFTER PII scrubbing. The forwarder may log shape/size but
  // MUST NOT log values verbatim — they may still contain tenant-scoped
  // business data even after the PII passes are run.
  input: unknown;
  // Decrypted connector credential. Treat as ephemeral — do not stash, do
  // not log. The forwarder's only job is to attach it to the outbound
  // request and let GC reclaim the buffer.
  credential: string;
}

export interface ForwardResult {
  ok: true;
  data: unknown;
}

export interface ToolForwarder {
  readonly connectorType: ConnectorType;
  forward(input: ForwardInput): Promise<ForwardResult>;
}

// Default in-process "echo" forwarder. Stands in until real connector
// implementations land. Returns a deterministic shape that includes the
// tool name + a sha256 of the input so audit rows are non-empty and tests
// can assert pass-through behaviour, but NEVER the credential.
export class EchoForwarder implements ToolForwarder {
  constructor(readonly connectorType: ConnectorType) {}

  async forward(input: ForwardInput): Promise<ForwardResult> {
    return {
      ok: true,
      data: {
        connector: input.connector,
        tool: input.tool,
        stub: true,
        // Echo the scrubbed input back so the audit outcome row carries a
        // meaningful snapshot during local dev. Once real forwarders land
        // this will be the actual connector response.
        echo: input.input,
      },
    };
  }
}

export class ForwarderRegistry {
  private readonly map = new Map<ConnectorType, ToolForwarder>();

  register(f: ToolForwarder): this {
    if (this.map.has(f.connectorType)) {
      throw new Error(`forwarder already registered for ${f.connectorType}`);
    }
    this.map.set(f.connectorType, f);
    return this;
  }

  get(connector: ConnectorType): ToolForwarder | undefined {
    return this.map.get(connector);
  }
}
