import OpenAI from 'openai';
import {
  OpenAICompatibleRuntime,
  assertSafeHeaderValue,
} from './openai-compatible.js';

// OpenAI direct runtime. Talks straight to https://api.openai.com/v1
// instead of routing through OpenRouter, so tenants who hold their own
// OpenAI account pay OpenAI's bare rate (no router markup) and operate
// under their own ToS / data-handling agreement.
//
// All chat-loop logic, content normalization, usage validation, cost
// ceiling enforcement, and header-injection guards live in
// OpenAICompatibleRuntime — this file only constructs the SDK client
// (API key, baseURL, optional org/project attribution headers).
//
// Model identifiers passed to AgentRuntime.run(input.model) must be the
// bare OpenAI IDs ('gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5'). The
// 'openai/...' route prefix used by OpenRouter is NOT accepted here.

export interface OpenAIRuntimeOptions {
  apiKey?: string;
  baseURL?: string;
  // OpenAI org and project IDs surface as OpenAI-Organization and
  // OpenAI-Project on each request. Useful for usage attribution when
  // a tenant has multiple projects under one key, or for enforcing
  // project-level rate limits.
  organization?: string;
  project?: string;
}

export class OpenAIRuntime extends OpenAICompatibleRuntime {
  readonly provider = 'openai';
  protected readonly providerLabel = 'openai';

  constructor(opts: OpenAIRuntimeOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    // Reject control characters in header values (CR/LF/NUL + U+2028/2029)
    // in case org/project ever flow from per-tenant config that an
    // operator might paste from elsewhere.
    if (opts.organization !== undefined) {
      assertSafeHeaderValue('organization', opts.organization);
    }
    if (opts.project !== undefined) {
      assertSafeHeaderValue('project', opts.project);
    }
    super(
      new OpenAI({
        apiKey,
        baseURL: opts.baseURL ?? 'https://api.openai.com/v1',
        ...(opts.organization ? { organization: opts.organization } : {}),
        ...(opts.project ? { project: opts.project } : {}),
      }),
    );
  }
}
