-- Ops Engine v0.3.1 request event dedupe

-- Remove duplicate rows for the same request_id, keeping the earliest stored row.
DELETE FROM request_events
WHERE request_id IS NOT NULL
  AND request_id != ''
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM request_events
    WHERE request_id IS NOT NULL AND request_id != ''
    GROUP BY request_id
  );

-- Prevent future duplicate request ids.
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_events_unique_request_id
ON request_events(request_id)
WHERE request_id IS NOT NULL AND request_id != '';
