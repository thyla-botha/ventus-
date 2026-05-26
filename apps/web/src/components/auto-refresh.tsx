'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// Calls router.refresh() every `intervalMs` while `active` is true. Used by
// /runs/[id] to poll the open Run row without a full reload (router.refresh
// re-runs the server component and patches the RSC payload — preserves scroll).
//
// Caps at `maxAttempts` so a run that's been orphaned in 'running' (e.g.
// API crashed mid-loop) doesn't have the browser polling forever. After the
// cap the component renders a small notice with a manual refresh link.

const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_MAX_ATTEMPTS = 60; // ~90s of polling, then bail

export function AutoRefresh({
  active,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  // Bumping `resetKey` (e.g. when a user cancels a long-running run) zeros
  // the attempt counter so polling resumes even if it had paused. Used by
  // /runs/[id] keyed on cancelRequestedAt so a late cancel still observes
  // the eventual 'aborted' transition.
  resetKey,
}: {
  active: boolean;
  intervalMs?: number;
  maxAttempts?: number;
  resetKey?: string | number;
}) {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);
  const stopped = attempts >= maxAttempts;

  // Reset the attempt counter whenever resetKey changes.
  useEffect(() => {
    setAttempts(0);
  }, [resetKey]);

  useEffect(() => {
    if (!active || stopped) return;
    const id = setInterval(() => {
      setAttempts((n) => n + 1);
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router, stopped]);

  if (active && stopped) {
    return (
      <div
        className="muted"
        style={{ padding: '6px 10px', fontSize: 12, marginBottom: 8 }}
      >
        Auto-refresh paused after {maxAttempts} attempts.{' '}
        <a
          href=""
          onClick={(e) => {
            e.preventDefault();
            setAttempts(0);
          }}
        >
          Resume polling
        </a>{' '}
        or refresh the page manually.
      </div>
    );
  }
  return null;
}
