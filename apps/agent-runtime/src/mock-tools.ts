import type { ToolDefinition, ToolExecutor } from './runtime.js';

// Mock tool executor for local CLI development. Returns deterministic stub data
// so the agent loop can be exercised end-to-end without a live MCP gateway,
// Postgres, or connector OAuth. Replace with mcp-gateway dispatch once that
// component is built.

export const MOCK_TOOLS: ToolDefinition[] = [
  {
    name: 'list_recent_documents',
    description:
      'List recent documents from a connector. Returns id, source_type, title, snippet, and timestamp for each.',
    inputSchema: {
      type: 'object',
      properties: {
        source_type: {
          type: 'string',
          enum: ['email', 'slack', 'jira', 'gdrive'],
          description: 'Which connector to read from.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      required: ['source_type'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_document',
    description: 'Fetch the full body of a single document by ID.',
    inputSchema: {
      type: 'object',
      properties: { document_id: { type: 'string', format: 'uuid' } },
      required: ['document_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_documents',
    description:
      'Semantic search across the tenant document corpus. Returns ranked chunks with citations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        source_types: {
          type: 'array',
          items: { type: 'string', enum: ['email', 'slack', 'jira', 'gdrive'] },
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

const FIXTURE_DOCS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    source_type: 'email',
    title: 'Withdrawal still pending after 5 days',
    snippet: 'Hi, I submitted my withdrawal on Monday and it still shows pending. I need this money urgently for...',
    from: 'jane.client@example.com',
    timestamp: '2026-05-25T08:14:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    source_type: 'email',
    title: 'Re: KYC document upload',
    snippet: "Thanks for the confirmation. I'll wait for verification.",
    from: 'happy.customer@example.com',
    timestamp: '2026-05-25T07:42:00Z',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    source_type: 'email',
    title: 'Cannot log in - 2FA broken',
    snippet: "I changed phones yesterday and now I can't access my account. Lost the authenticator codes...",
    from: 'frustrated.user@example.com',
    timestamp: '2026-05-25T09:01:00Z',
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    source_type: 'email',
    title: 'Win a free iPhone!!!',
    snippet: 'Click here to claim your prize. Limited time offer.',
    from: 'noreply@spam.example.com',
    timestamp: '2026-05-25T03:22:00Z',
  },
];

interface MockTools {
  listRecent: (args: { source_type: string; limit?: number }) => unknown;
  getDocument: (args: { document_id: string }) => unknown;
  search: (args: { query: string; limit?: number; source_types?: string[] }) => unknown;
}

const impl: MockTools = {
  listRecent: ({ source_type, limit }) => {
    const filtered = FIXTURE_DOCS.filter((d) => d.source_type === source_type);
    return { documents: filtered.slice(0, limit ?? 25) };
  },
  getDocument: ({ document_id }) => {
    const doc = FIXTURE_DOCS.find((d) => d.id === document_id);
    if (!doc) return { error: 'not found', document_id };
    return {
      ...doc,
      body: `${doc.snippet}\n\n[mock body — replace with real connector output]`,
    };
  },
  search: ({ query, limit }) => ({
    query,
    results: FIXTURE_DOCS.slice(0, limit ?? 10).map((d) => ({
      document_id: d.id,
      title: d.title,
      snippet: d.snippet,
      score: 0.5,
    })),
  }),
};

export const mockToolExecutor: ToolExecutor = async (name, input) => {
  switch (name) {
    case 'list_recent_documents':
      return impl.listRecent(input as { source_type: string; limit?: number });
    case 'get_document':
      return impl.getDocument(input as { document_id: string });
    case 'search_documents':
      return impl.search(input as { query: string; limit?: number; source_types?: string[] });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
};
