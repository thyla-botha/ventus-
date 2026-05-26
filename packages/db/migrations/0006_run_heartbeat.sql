-- Run heartbeat column. The agent loop writes `now()` to this column at the
-- top of each step (via RunStore.heartbeat). A separate reaper process
-- scans for 'running' rows whose heartbeat is older than a stale threshold
-- and closes them as 'failed' with errorText='no heartbeat'.
--
-- Why on the same table as the run row: the heartbeat IS run liveness; it
-- doesn't make sense to chase a row + heartbeat across two tables. A
-- per-step UPDATE on the same row is cheap (~100 bytes) and avoids any
-- write-amplification from heartbeat-only tables.
--
-- Column is nullable because: (a) the reaper falls back to started_at for
-- rows that died before their first step_started, and (b) legacy rows
-- predating this migration carry no heartbeat at all.

ALTER TABLE runs
  ADD COLUMN last_heartbeat_at timestamptz;

-- Partial index: the reaper's hot query is "running rows whose heartbeat
-- is older than X". Only running rows matter — terminal rows are never
-- considered. NULL heartbeats are excluded here (the reaper falls back to
-- started_at in code for that case), keeping this index small.
CREATE INDEX runs_running_heartbeat_idx
  ON runs(last_heartbeat_at)
  WHERE status = 'running' AND last_heartbeat_at IS NOT NULL;
