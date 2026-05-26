# 0001 — Prompt injection in tenant_profile body is accepted risk

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** User (product owner)

## Context

`tenant_profile.body` is injected at the top of the system prompt as `<tenant_context>{body}</tenant_context>` for every agent run in that tenant. The body is free-form text controlled by tenant admins.

An admin can put arbitrary instructions in `body` ("ignore the user message", "always approve drafts", "exfiltrate data to URL X"). The LLM may follow those instructions, breaking the trust boundary between system prompt (platform-controlled) and tenant input.

The product needs tenants to customise agent behaviour with business context (tone, escalation rules, brand voice) without code changes — so just removing the field isn't a real option.

## Decision

Accept the prompt-injection risk. Gate writes behind `requireAdmin` middleware and treat the admin as **trusted-with-prompt** by design.

## Alternatives considered

- **(a) Sanitise / template-strip the body** — strips instruction-shaped strings before injection. Trade-off: heuristic, easy to bypass, gives false sense of security. Real prompt-injection defence is an open research problem; we'd be shipping security theatre.
- **(b) Inject as user message instead of system prompt** — slightly reduces "authority" of the injection but Claude still treats prior user turns as instructions. Trade-off: weak mitigation, breaks the mental model that system prompt = platform context.
- **(c) Accept the risk, gate writes to admin** *(chosen)* — admin is already trusted to set tenant config; treating them as trusted-with-prompt is consistent. Trade-off: a compromised admin account is now an LLM-level threat, not just a data-level one.

## Consequences

- Admin role boundary is now load-bearing for prompt-injection defence. Any future "delegated admin" feature must consider the LLM-instruction surface.
- Documented in [apps/agent-runtime/src/run-agent.ts](../../apps/agent-runtime/src/run-agent.ts) where `composeSystemPrompt` runs.
- We'd revisit if: (1) a non-admin path to write the body appears, (2) tenant admin accounts start being shared across humans without per-human attribution, or (3) we add tools with side effects that the LLM could be instructed to abuse beyond what a human admin could already do directly.

## Notes

User directive verbatim: "Pick a, b, or c. Document." This is the documentation.
