-- Run provenance: pin the exact skill bytes + the canonicalised effective
-- context for each Run, and copy the snapshot hash onto every Proposal and
-- audit_intent the Run produces.
--
-- Why on EVERY child row (not just the parent Run): proposals + audit rows
-- outlive the orchestrator. If a future admin / process mutates the Run row
-- (intentionally or otherwise), child rows still carry the originating hash
-- and can be verified independently.
--
-- Both columns are NULLABLE because legacy / hand-written rows predating
-- this migration have no provenance to record. New writes from the agent
-- runtime always populate them.

ALTER TABLE runs
  ADD COLUMN skill_content_hash    text,
  ADD COLUMN context_snapshot_hash text;

ALTER TABLE proposals
  ADD COLUMN context_snapshot_hash text;

ALTER TABLE audit_intents
  ADD COLUMN context_snapshot_hash text;

-- Lookup index: "find every proposal/intent that ran against snapshot X".
-- Useful when responding to an auditor asking "which downstream actions
-- came from this exact prompt". Partial index keeps it small while the
-- column is rolling out (most older rows will be NULL).
CREATE INDEX proposals_snapshot_idx
  ON proposals(tenant_id, context_snapshot_hash)
  WHERE context_snapshot_hash IS NOT NULL;

CREATE INDEX audit_intents_snapshot_idx
  ON audit_intents(tenant_id, context_snapshot_hash)
  WHERE context_snapshot_hash IS NOT NULL;
