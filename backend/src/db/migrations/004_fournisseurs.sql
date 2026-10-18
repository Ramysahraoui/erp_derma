-- =====================================================================
-- Gestion des fournisseurs : historique des modifications de fiche.
-- =====================================================================

CREATE TABLE fournisseurs_modifications (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fournisseur_id   BIGINT NOT NULL REFERENCES fournisseurs(id),
  champ            TEXT NOT NULL,
  ancienne_valeur  TEXT,
  nouvelle_valeur  TEXT,
  utilisateur_id   BIGINT REFERENCES utilisateurs(id),
  cree_le          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_fournisseurs_modifications ON fournisseurs_modifications (fournisseur_id, cree_le DESC);
CREATE TRIGGER trg_fournisseurs_modifications_no_delete BEFORE DELETE ON fournisseurs_modifications
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

-- Un fournisseur reference par des receptions, lots, commandes ou depenses ne
-- se supprime pas : il se desactive.
CREATE TRIGGER trg_fournisseurs_no_delete BEFORE DELETE ON fournisseurs
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();
