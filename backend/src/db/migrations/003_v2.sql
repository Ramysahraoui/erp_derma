-- =====================================================================
-- V2 : certificat facultatif, historique des statuts de lot, historique
-- des modifications d'articles, solde client tenant compte des avoirs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Certificat d'analyse facultatif (CDCF V2 2.2) : un lot peut etre
--    libere sans certificat, celui-ci pouvant etre joint ulterieurement.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_liberation_coa ON lots_stock;
DROP FUNCTION IF EXISTS fn_liberation_exige_coa();

-- ---------------------------------------------------------------------
-- 2. Historique des statuts qualite d'un lot : le rejet puis une eventuelle
--    reintroduction restent lisibles en chronologie (CDCF V2 2.3).
-- ---------------------------------------------------------------------
CREATE TABLE lots_statuts_historique (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_stock_id    BIGINT NOT NULL REFERENCES lots_stock(id),
  ancien_statut   statut_lot,
  nouveau_statut  statut_lot NOT NULL,
  nature          TEXT NOT NULL DEFAULT 'CHANGEMENT_STATUT',
  motif           TEXT,
  utilisateur_id  BIGINT REFERENCES utilisateurs(id),
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lots_statuts_lot ON lots_statuts_historique (lot_stock_id, cree_le);
CREATE TRIGGER trg_lots_statuts_no_delete BEFORE DELETE ON lots_statuts_historique
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

-- Reprise de l'historique deja present dans le journal d'audit.
INSERT INTO lots_statuts_historique (lot_stock_id, ancien_statut, nouveau_statut, motif, utilisateur_id, cree_le)
SELECT a.entite_id::bigint,
       (a.details->>'ancien_statut')::statut_lot,
       (a.details->>'nouveau_statut')::statut_lot,
       a.details->>'motif',
       a.utilisateur_id,
       a.cree_le
  FROM audit_log a
 WHERE a.action = 'CHANGEMENT_STATUT_LOT'
   AND a.entite = 'lots_stock'
   AND EXISTS (SELECT 1 FROM lots_stock l WHERE l.id = a.entite_id::bigint);

-- ---------------------------------------------------------------------
-- 3. Historique des modifications d'articles (CDCF V2 2.1) : utilisateur,
--    date, ancienne et nouvelle valeur, champ par champ.
-- ---------------------------------------------------------------------
CREATE TABLE articles_modifications (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id       BIGINT NOT NULL REFERENCES articles_catalogue(id),
  champ            TEXT NOT NULL,
  ancienne_valeur  TEXT,
  nouvelle_valeur  TEXT,
  utilisateur_id   BIGINT REFERENCES utilisateurs(id),
  cree_le          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_articles_modifications ON articles_modifications (article_id, cree_le DESC);
CREATE TRIGGER trg_articles_modifications_no_delete BEFORE DELETE ON articles_modifications
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

-- ---------------------------------------------------------------------
-- 4. Etat client (CDCF V2 2.4, anomalie critique) : un encaissement non
--    affecte a une facture constitue un avoir qui diminue le solde du.
--    Un cheque impaye n'est ni un paiement ni un avoir.
-- ---------------------------------------------------------------------

-- Une affectation n'est jamais supprimee : lorsqu'un cheque revient impaye,
-- ses affectations sont annulees (tracees) et la somme redevient due. Chaque
-- imputation est une ligne distincte, d'ou la levee de l'unicite
-- (encaissement, facture).
ALTER TABLE encaissement_affectations
  ADD COLUMN annulee     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN annulee_le  TIMESTAMPTZ,
  ADD COLUMN origine     TEXT NOT NULL DEFAULT 'MANUELLE';
ALTER TABLE encaissement_affectations
  DROP CONSTRAINT IF EXISTS encaissement_affectations_encaissement_id_document_id_key;
CREATE INDEX idx_affectations_encaissement ON encaissement_affectations (encaissement_id) WHERE NOT annulee;

-- Reprise de l'existant : la V1 laissait compter les affectations des cheques
-- impayes lors des recalculs ulterieurs.
UPDATE encaissement_affectations ea
   SET annulee = TRUE, annulee_le = NOW()
  FROM encaissements e
 WHERE e.id = ea.encaissement_id AND e.cheque_statut = 'IMPAYE' AND NOT ea.annulee;
UPDATE encaissements SET montant_affecte = 0 WHERE cheque_statut = 'IMPAYE';

UPDATE ventes_documents v
   SET montant_paye = sub.paye,
       statut_paiement = CASE
         WHEN sub.paye <= 0 THEN 'NON_PAYEE'::statut_paiement
         WHEN sub.paye >= v.total_ttc - 0.005 THEN 'SOLDEE'::statut_paiement
         ELSE 'PARTIELLE'::statut_paiement END
  FROM (
    SELECT d.id,
           COALESCE((SELECT SUM(ea.montant_affecte) FROM encaissement_affectations ea
                      WHERE ea.document_id = d.id AND NOT ea.annulee), 0) AS paye
      FROM ventes_documents d
     WHERE d.type_doc = 'FACTURE'
  ) sub
 WHERE v.id = sub.id;

CREATE OR REPLACE VIEW v_encours_clients AS
SELECT c.id AS client_id,
       c.code,
       c.raison_sociale,
       c.plafond_credit,
       c.delai_paiement_jours,
       c.bloque,
       COALESCE(SUM(d.total_ttc - d.montant_paye) FILTER (
         WHERE d.type_doc = 'FACTURE' AND d.statut = 'VALIDE' AND d.statut_paiement <> 'SOLDEE'
       ), 0) AS encours_facture,
       COALESCE(SUM(d.total_ttc) FILTER (
         WHERE d.type_doc = 'BL' AND d.statut = 'VALIDE'
           AND NOT EXISTS (SELECT 1 FROM ventes_documents f
                            WHERE f.document_parent_id = d.id AND f.type_doc = 'FACTURE' AND f.statut = 'VALIDE')
       ), 0) AS encours_livre_non_facture,
       COALESCE(SUM(d.total_ttc - d.montant_paye) FILTER (
         WHERE d.type_doc = 'FACTURE' AND d.statut = 'VALIDE'
           AND d.statut_paiement <> 'SOLDEE'
           AND d.date_echeance IS NOT NULL AND d.date_echeance < CURRENT_DATE
       ), 0) AS encours_echu,
       -- Ajouts V2 (en fin de vue pour rester compatible avec CREATE OR REPLACE)
       COALESCE((SELECT SUM(e.montant_verse - e.montant_affecte)
                   FROM encaissements e
                  WHERE e.client_id = c.id
                    AND e.cheque_statut IS DISTINCT FROM 'IMPAYE'), 0) AS avoir_disponible
  FROM clients c
  LEFT JOIN ventes_documents d ON d.client_id = c.id
 GROUP BY c.id;
