export class VentusError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 500,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'VentusError';
  }
}

export class TenantContextMissing extends VentusError {
  constructor() {
    super('tenant context not set', 'TENANT_CONTEXT_MISSING', 500);
  }
}

export class ForbiddenError extends VentusError {
  constructor(msg = 'forbidden') {
    super(msg, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends VentusError {
  constructor(msg = 'not found') {
    super(msg, 'NOT_FOUND', 404);
  }
}

export class CostCeilingExceeded extends VentusError {
  constructor(readonly agentId: string, readonly spentCents: number, readonly ceilingCents: number) {
    super(
      `agent ${agentId} exceeded cost ceiling (${spentCents}/${ceilingCents} cents)`,
      'COST_CEILING_EXCEEDED',
      429,
    );
  }
}

export class AgentsHalted extends VentusError {
  constructor(readonly tenantId: string) {
    super(`agents disabled for tenant ${tenantId}`, 'AGENTS_HALTED', 503);
  }
}
