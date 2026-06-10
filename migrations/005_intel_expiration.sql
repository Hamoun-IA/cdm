-- 005 — Expiration explicite des fiches Scout.
-- Justification : les infos blessures/compos/contexte sont sensibles au temps ;
-- l'UI et les agents doivent pouvoir distinguer frais, périmé et non confirmé.
ALTER TABLE match_intel ADD COLUMN fresh_until TEXT;
ALTER TABLE match_intel ADD COLUMN freshness_note TEXT;
