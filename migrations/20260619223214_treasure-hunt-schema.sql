-- players: one row per identity (real localStorage UUIDs + seeded fakes)
CREATE TABLE public.players (
  id                  uuid PRIMARY KEY,
  name                text,
  is_seed             boolean NOT NULL DEFAULT false,
  clues_solved        integer NOT NULL DEFAULT 0,
  hints_used          integer NOT NULL DEFAULT 0,
  total_time_seconds  integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- clues: one row per clue instance (live state + history + per-clue timing)
CREATE TABLE public.clues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id        uuid NOT NULL REFERENCES public.players(id),
  origin_location  text NOT NULL,
  origin_lat       double precision NOT NULL,
  origin_lng       double precision NOT NULL,
  landmark_name    text NOT NULL,
  landmark_lat     double precision NOT NULL,
  landmark_lng     double precision NOT NULL,
  landmark_desc    text NOT NULL DEFAULT '',
  landmark_osm_id  text NOT NULL DEFAULT '',
  riddle           text NOT NULL,
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','solved','abandoned')),
  hints_used       integer NOT NULL DEFAULT 0,
  hint_image_url   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  solved_at        timestamptz
);

-- one active clue per player at a time (idempotency / state-machine guard)
CREATE UNIQUE INDEX clues_one_active_per_player
  ON public.clues (player_id) WHERE status = 'active';

CREATE INDEX clues_player_created ON public.clues (player_id, created_at DESC);

-- Lock the tables: anon (public API key) gets nothing. The edge function
-- uses the admin/service key, which bypasses RLS.
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clues   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.players FROM anon;
REVOKE ALL ON public.clues   FROM anon;

-- Seeded fake leaderboard players (so the live player lands ~#2 of 5).
INSERT INTO public.players (id, name, is_seed, clues_solved, hints_used, total_time_seconds) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Marco',  true, 5, 1, 1820),
  ('22222222-2222-2222-2222-222222222222', 'Yuki',   true, 3, 0, 1500),
  ('33333333-3333-3333-3333-333333333333', 'Priya',  true, 2, 2, 2100),
  ('44444444-4444-4444-4444-444444444444', 'Diego',  true, 1, 3, 2600);
