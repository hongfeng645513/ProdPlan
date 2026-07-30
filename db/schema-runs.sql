-- Measured furnace runs, imported from the MCGS instrument export.
--
-- This is a different kind of data from `curve_points`. Curve points are the
-- *reference* profile a furnace is expected to follow — one idealised cycle,
-- sampled hourly, that the planner derives phases and capacity from. These
-- tables hold what actually happened: every probe, every 30 seconds, run after
-- run, including the runs that went badly.
--
-- The point of keeping them is the cooling constant. The README notes that
-- natural cooling "differs from machine to machine and drifts over time", yet k
-- is currently fitted once from whatever the workbook captured. With real runs
-- stored, k can be refitted against how the furnace behaves *now*.
--
--   psql "$PGCONNSTRING" -f db/schema-runs.sql

BEGIN;

CREATE TABLE IF NOT EXISTS runs (
  id            bigserial PRIMARY KEY,
  machine_id    text NOT NULL REFERENCES machines(id) ON DELETE CASCADE,

  -- Instrument wall-clock time, stored WITHOUT a time zone on purpose: the
  -- MCGS export carries no offset, so tagging it UTC would be a guess that
  -- silently shifts every timestamp. Elapsed time is what the cooling fit
  -- needs, and that is unaffected.
  started_at    timestamp NOT NULL,
  ended_at      timestamp NOT NULL,

  sample_count  integer NOT NULL,
  peak_temp_c   numeric,
  set_point_c   numeric,          -- highest set point seen; 0 means never fired

  -- The moment the element went off, detected from Set Temp falling to zero.
  -- Null when the run never fired or the transition is not in the data.
  heat_off_at   timestamp,

  -- Newton's-law fit over this run's own cooling branch. Kept per run rather
  -- than averaged in, so a bad run can be inspected and excluded instead of
  -- quietly dragging the machine's constant around.
  fitted_k      numeric,
  fit_rmse_c    numeric,
  fit_points    integer,

  source_file   text,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  note          text,

  -- Re-importing the same export must not duplicate runs.
  UNIQUE (machine_id, started_at)
);

CREATE TABLE IF NOT EXISTS run_samples (
  run_id     bigint NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at         timestamp NOT NULL,
  temp_a     numeric,
  temp_b     numeric,
  temp_c     numeric,
  set_temp   numeric,
  vacuum     numeric,
  pressure   numeric,
  water_temp numeric,
  PRIMARY KEY (run_id, at)
);

CREATE INDEX IF NOT EXISTS run_samples_run_idx ON run_samples (run_id, at);
CREATE INDEX IF NOT EXISTS runs_machine_idx ON runs (machine_id, started_at DESC);

-- An operator-applied cooling constant, overriding the one derived from the
-- reference curve. This IS source data — a human decided to trust a measured
-- refit over the workbook — so unlike phases or capacity it is stored.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS cooling_k_override numeric;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS cooling_k_source text;

COMMIT;

-- Provenance for the reference curve.
--
-- Replacing a furnace's reference curve changes its phases, its cooling fit, its
-- cycle length and therefore every plan it appears in. Recording which run the
-- curve came from makes that traceable rather than a silent change in the
-- numbers — and lets the app say "measured, 18 Nov" instead of leaving an
-- operator to wonder why the cycle time moved.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS curve_source_run_id bigint
  REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS curve_source_label text;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS curve_updated_at timestamptz;
