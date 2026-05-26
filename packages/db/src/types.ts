// Hand-written core types. Replace with `supabase gen types typescript` output
// once the Supabase project is wired.

export type Plan = 'pilot' | 'growth' | 'scale' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'archived';
export type UserRole = 'owner' | 'admin' | 'approver' | 'member' | 'viewer';
export type ConnectorType = 'gmail' | 'gdrive' | 'slack' | 'jira' | 'clickup' | 'whatsapp';
export type ConnectorStatus = 'pending' | 'active' | 'error' | 'revoked';
export type AgentTier = 1 | 2 | 3;
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'halted' | 'timeout';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';
export type Verdict = 'approved' | 'rejected' | 'edited';
export type AuditActorType = 'user' | 'agent' | 'system';
export type AuditOutcomeStatus =
  | 'executed'
  | 'failed'
  | 'rolled_back'
  | 'approved'
  | 'rejected'
  | 'timeout'
  | 'dropped';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  status: TenantStatus;
  agents_enabled: boolean;
  settings: Record<string, unknown>;
  encryption_key_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  status: 'active' | 'invited' | 'suspended';
  created_at: string;
  updated_at: string;
}

export interface AuditIntent {
  id: string;
  tenant_id: string;
  run_id: string | null;
  step_no: number;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  tool_name: string | null;
  payload: unknown;
  payload_hash: string | null;
  proposed_at: string;
}

export interface AuditOutcome {
  id: string;
  intent_id: string;
  tenant_id: string;
  status: AuditOutcomeStatus;
  result: unknown;
  result_hash: string | null;
  error_text: string | null;
  duration_ms: number | null;
  cost_usd_micros: number | null;
  recorded_at: string;
}
