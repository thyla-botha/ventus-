# Legal brief: EU AI Act + FAIS exposure for an agentic operations platform

**Audience:** Lawyer with EU AI Act + financial-services compliance experience (preferably with SA + EU dual-jurisdiction practice).
**Purpose:** Scope provider/deployer obligations, Annex III classification, FAIS rep accountability, CySEC outsourcing implications, and POPIA cross-border posture before product is placed on market.
**Timing pressure:** EU AI Act high-risk obligations (Annex III) become enforceable 2 August 2026 — approximately 10 weeks from today (2026-05-25).

---

## 1. Factual setup

**The product.** A multi-tenant SaaS platform that:

- Ingests a tenant's business communications and documents from Gmail, Google Drive, Slack, Jira, ClickUp, and (later) WhatsApp Business via OAuth-mediated connectors.
- Builds tenant-scoped retrieval and entity layers (vector embeddings + entity graph) in a Postgres database.
- Deploys AI agents in three operating tiers:
  - **Tier 1 — Read-only briefings.** Generates summaries and analyses. No external action.
  - **Tier 2 — Drafts requiring human approval.** Produces draft customer replies, ticket comments, or escalation notes that a human reviews and approves before they leave the system.
  - **Tier 3 — Constrained execution.** Performs narrowly scoped actions (e.g., re-routing a support ticket within a single Jira project) under a pre-approved tenant policy.
- All Tier 2 and Tier 3 actions are logged to an immutable audit trail (intent + outcome rows joined by run ID).

**Who deploys it.** Mid-market businesses across two initial vertical packs:

- **Real estate agencies** — RE/MAX-style brokerages in SA. Non-regulated for AI Act purposes.
- **Retail forex brokerages** — licensed by FSCA (SA), and in subsequent client cohorts CySEC (Cyprus) and FCA (UK). These are the higher-stakes deployers.

**Where data flows.**

| Stage | Location | Provider |
|---|---|---|
| Source systems | Tenant's own Google Workspace, Slack, Jira | Tenant-controlled |
| Ingestion / storage | Hetzner data centre, Germany (Postgres + pgvector) | Hetzner (ISO 27001) |
| LLM inference (primary) | Anthropic API (US + EU regions) | Anthropic |
| LLM inference (overflow) | AWS Bedrock or Google Vertex (region-pinned) | AWS / Google |
| Observability | Self-hosted Langfuse on Hetzner | Operator-controlled |

**Who I am.** South Africa-incorporated, SA-domiciled founder. No EU establishment at present. POPIA-regulated as a Responsible Party for tenant employee data and as an Operator (processor) for tenant-customer data.

**Where on the AI Act timeline.** Prohibited-practices and AI literacy obligations already in force (Feb 2025). GPAI rules and governance (Aug 2025) already in force. **High-risk system obligations under Annex III become enforceable 2 August 2026.** Product target market-entry date is within this window.

---

## 2. Questions for the lawyer

### Q1 — Provider vs deployer classification

Under AI Act Article 3(3)–(4), am I the **provider** of the AI systems shipped as vertical packs, the **deployer**, or both — given that I author the agent definitions and Skills but the tenant configures connectors, approval workflows, and policies? Does my classification change for tenant-built workflows assembled on my platform (e.g., via an embedded workflow builder)?

### Q2 — Annex III triggering for the Withdrawal Complaint Drafter

A Tier 2 agent drafts a customer reply about withdrawal of client funds; a human (FAIS-registered rep or compliance officer) approves before sending. Does this qualify as high-risk under:

- Annex III (5)(b) — "creditworthiness or credit scoring," or
- Annex III (5)(c) — "access to essential private services," given that retail forex accounts function as a financial product?

Does the human-in-the-loop approval gate change classification, or only the oversight obligations (Article 14)? If approval is rubber-stamped in practice (low rejection rate), does that affect either the classification or our regulator-facing defence?

### Q3 — EU establishment trigger / Article 22 representative

I am SA-based. A CySEC-licensed broker deploying my system is an EU-established deployer. Under Article 2 (extraterritorial reach) and Article 22, does that alone bring me into provider obligations, and do I need:

- A formally appointed EU authorised representative, and/or
- An EU-domiciled subsidiary?

What is the practical minimum (single appointed-representative engagement vs full subsidiary establishment), and what does that representative actually need to do day-to-day?

### Q4 — Conformity assessment route, timeline, and consequence of mid-assessment sales

If the system is high-risk, which conformity assessment route applies — **Annex VI internal control** (typical for most Annex III systems other than biometrics) or **Annex VII notified body**? Realistic calendar + cost to complete pre-2 August 2026 with documentation produced from scratch? What is the regulator-facing posture if a CySEC broker signs a contract while assessment is in progress but not complete?

### Q5 — FAIS rep accountability when an AI drafts customer communication

When a Tier 2 agent drafts a withdrawal-complaint reply that a FAIS-registered rep approves and sends:

- Does the rep accept full FAIS General Code of Conduct liability for the content as if they had drafted it themselves?
- What supervisory framework does the FSCA require the broker to maintain to demonstrate adequate oversight of AI-drafted communications?
- What audit-trail fields and retention period (FAIS / FIC Act 5-year minimum?) must my platform preserve, and in what format, to defend the rep's supervisory adequacy under FSCA inspection?

### Q6 — CySEC outsourcing notification

Under CySEC's outsourcing directive (and the underlying MiFID II Article 16(5) / Commission Delegated Regulation 2017/565 outsourcing rules), does a CySEC broker need to **notify CySEC before deploying** my platform on functions touching client communications? If yes:

- Is this a "critical or important function" outsourcing (longer notification lead time, contractual specifics) or a lighter regime?
- Does the notification implicate me directly as the critical service provider — e.g., audit rights for CySEC, exit-plan requirements in my DPA?

### Q7 — POPIA cross-border + GDPR processor obligations

I'm SA-incorporated. Tenant data sits on Hetzner DE; inference traverses Anthropic (US + EU) and overflow Bedrock/Vertex. For:

- **SA tenants (POPIA):** Minimum Section 72 compliance posture for cross-border transfers, given EU = adequate destination but US = not? How to structure the Anthropic processing relationship (SCCs, IDTA, or POPIA-specific contract terms)?
- **EU tenants (GDPR):** Article 28 processor agreement terms with each tenant. Do I need an Article 27 GDPR representative in the EU separate from any AI Act Article 22 representative? Standard contractual clauses with Anthropic — who signs, on what footing?

### Q8 — Liability allocation in the DPA / MSA

Standard market liability allocation for an AI vendor at this risk profile, specifically:

- Agent drafts non-compliant communication; human approves; customer suffers loss. Who bears liability?
- Tier 3 agent executes pre-approved action causing loss. Who bears liability?
- PII scrubber fails to redact a customer ID; data reaches Anthropic's logs. Who bears liability?

Where is the market on liability caps (multiple of annual fees?), carve-outs (IP, confidentiality, data breach), and AI-specific indemnities? Where should I push for indemnity from clients vs accept it on their behalf?

---

## 3. What good answers look like (so you can tell whether the lawyer actually knows this)

**On Q1 (provider/deployer):** A lawyer who knows the Act will quote Article 3(3) and (4) language directly and discuss the placing-on-the-market trigger. They should distinguish vertical packs (you provider) from tenant-assembled workflows (likely you still provider of the underlying components, tenant deployer of the composition). If they say "South African company isn't in scope," walk out — Article 2 extraterritorial reach is settled.

**On Q2 (Annex III):** Should reference the specific Annex III numbering, recent Commission guidelines on prohibited practices (Feb 2025) and high-risk classification, and the Article 6(3) "without significant influence on the outcome" carve-out. Should explain that human-in-the-loop does not automatically declassify — it shapes Article 14 oversight obligations. If they say "just add an approval step and you're fine," that's wrong.

**On Q3 (establishment):** Should give a concrete recommendation between appointed representative vs subsidiary, with cost ranges (representative typically €1–3k/month; subsidiary substantially more). Should mention that the representative bears specific Article 22 obligations including documentation custody and authority-cooperation duties.

**On Q4 (conformity assessment):** Should name Annex VI vs Annex VII directly, give a realistic 6–12 month calendar for Annex VI from a standing start, and explain the technical documentation obligations under Annex IV. If they wave off the timeline as "paperwork," they're wrong — the documentation is substantive engineering work (data governance, risk management, testing protocols).

**On Q5 (FAIS):** Should cite FAIS General Code of Conduct sections directly (most likely Sections 3, 8, and 14), reference FIC Act 5-year retention, and distinguish FAIS "advice" from "intermediary service." Should know that even non-advice communications attract supervisory obligations under the rep's accountability framework.

**On Q6 (CySEC outsourcing):** Should reference the specific CySEC outsourcing directive and the underlying MiFID II framework. Should give a concrete notification lead time (typically 30–90 days for critical outsourcing) and discuss minimum contractual content (audit rights, sub-outsourcing, exit, business continuity). If they treat it as internal control only, yellow flag.

**On Q7 (POPIA + GDPR):** Should reference POPIA Section 72 cross-border conditions and distinguish the EU (adequate via mutual recognition trajectory) from US (not adequate, needs supplemental measures). Should mention the EU Commission's standard contractual clauses for processor-to-processor and processor-to-sub-processor. Should not conflate POPIA's Operator concept with GDPR's Processor concept loosely.

**On Q8 (liability):** Should give specific market ranges (cap typically 1x–2x annual fees in software, often higher for AI-vendor pushback; carve-outs for IP, confidentiality, gross negligence, wilful misconduct, data breach above cap). Should distinguish AI-specific indemnities (output infringement, bias claims) from standard tech indemnities.

---

## 4. Red flags — sit up and reconsider the lawyer if you hear

- "EU AI Act doesn't apply to South African companies." (Extraterritorial reach is explicit.)
- "Just have a human approve everything and you're fine." (Annex III classification attaches to the system; HITL changes oversight obligations, not classification.)
- "We can sort the AI Act out once you have customers." (High-risk enforcement is 2 August 2026.)
- "Conformity assessment is just internal paperwork." (Substantive engineering + documentation + risk management exercise.)
- Quoting the AI Act regulation text without ever referencing the Commission guidelines or recent enforcement signalling. (Means they're reading the statute, not following how it's actually being applied.)
- Quoting FAIS without citing General Code of Conduct sections. (Means they know FAIS by reputation, not in detail.)
- Treating CySEC outsourcing as a footnote. (It's a deal-blocker if missed.)

---

## 5. What you want out of the engagement

- A **written opinion** covering Q1–Q4 (AI Act exposure) at minimum, in a form you can show to a CySEC broker's compliance officer.
- A **decision** on EU authorised representative vs subsidiary, with a concrete cost and a recommended provider.
- A **conformity assessment plan** with milestones backwards from 2 August 2026.
- **Template DPA + MSA language** for AI-specific liability allocation that you can use as your default position with all tenants.
- A **FAIS audit-trail field list** the lawyer will sign off as defensible under FSCA inspection.

**Budget guidance:** R30k–R60k for the initial opinion + DPA template. Annex VI conformity assessment documentation work is a separate engagement (likely R150k–R350k or partially substitutable with structured internal work + lawyer review).

---

*Date prepared: 2026-05-25. Treat the EU AI Act enforcement date as fixed at 2 August 2026; everything else flows backwards from there.*
