-- ProdPlan — source data for the GO-film line.
--
-- Only SOURCE data lives here: what a human types in. Everything the app can
-- work out for itself — phase boundaries, the Newton cooling fit, batch
-- capacity, the machine-readable form of the rules — is derived on read by
-- src/lib/derive.js and deliberately NOT stored.
--
-- The reason is that this data is about to become editable in the app. A stored
-- cooling constant is one curve edit away from being silently wrong, and a
-- wrong k does not look wrong: it just quietly misprices every cycle length.
-- Derive it every time and it cannot rot.
--
--   psql "$PGCONNSTRING" -f db/schema.sql
--   psql "$PGCONNSTRING" -f db/seed.sql

BEGIN;

CREATE TABLE IF NOT EXISTS machines (
  id             text PRIMARY KEY,          -- slug, e.g. 'furnace-1'
  name           text NOT NULL,
  model          text NOT NULL DEFAULT '',
  function       text NOT NULL DEFAULT '',  -- 'Carbonization' | 'Graphitization'
  holders        integer,
  gf_size        text NOT NULL DEFAULT '',
  gf_per_holder  numeric,                   -- grams of GO film per holder
  yield          numeric,                   -- applied once, at graphitization
  has_open_marker boolean NOT NULL DEFAULT false,
  sort_name      text GENERATED ALWAYS AS (name) STORED,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The measured temperature curve: controlled heating and soak are accurate and
-- tabulated, the cooling tail is sampled and then modelled. One row per sample.
CREATE TABLE IF NOT EXISTS curve_points (
  machine_id  text NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  t_hours     numeric NOT NULL,
  temp_c      numeric NOT NULL,
  PRIMARY KEY (machine_id, t_hours)
);

-- Scheduling constraints, one plain-English sentence per row, exactly as they
-- appeared on the workbook's Rules sheet.
--
-- They are stored as text rather than as structured columns because the parser
-- (src/lib/derive.js parseRules) reports anything it cannot interpret as a
-- visible warning. That contract — a rule is either enforced or visibly NOT
-- enforced, never silently dropped — is worth more than tidy columns while the
-- rules are still authored as sentences. When the editing UI replaces free text
-- with structured input, this table gains `kind` and `params jsonb` and the
-- parse-failure category disappears with it.
CREATE TABLE IF NOT EXISTS rules (
  id    integer PRIMARY KEY,   -- also the display order
  text  text NOT NULL
);

-- Maximum current per piece of plant, off the Electricity sheet.
--
-- Three states are kept apart on purpose, because they mean different things:
--   max_amps set, rated = true    a rating the plan can hold itself to
--   needs_input = true            sheet said "Unknown"; the operator types it
--   max_amps NULL, rated = false  nothing claimed; counted as 0 A AND warned
--
-- Do not collapse this into a nullable max_amps. Guessing a value for the third
-- case would quietly raise the current ceiling, which is the one failure a
-- current limit exists to prevent.
CREATE TABLE IF NOT EXISTS equipment (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  max_amps     numeric,
  rated        boolean NOT NULL DEFAULT false,
  needs_input  boolean NOT NULL DEFAULT false
);

COMMIT;
