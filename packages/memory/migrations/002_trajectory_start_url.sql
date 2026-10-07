-- Trajectory.startUrl (protocol tasks.ts) is required by the replayer
-- (integration §10: navigate to trajectory.startUrl before replaying), but
-- schema 001 predates it. Add it rather than squeezing the URL into steps_json.
ALTER TABLE trajectories ADD COLUMN start_url TEXT NOT NULL DEFAULT '';
