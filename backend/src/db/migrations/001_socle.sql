-- =====================================================================
-- ERP DERMO-COSMETIQUE - Socle relationnel (Jalon 1 a 4)
-- Moteur : PostgreSQL 14+
-- Principes : integrite referentielle stricte, audit trail (pas de DELETE
-- sur les tables de tracabilite), precision DECIMAL pour masses et devises.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Types metier
-- ---------------------------------------------------------------------
CREATE TYPE type_article        AS ENUM ('MP','AC','PF');
CREATE TYPE statut_lot          AS ENUM ('QUARANTAINE','CONFORME','REJETE','BLOQUE');
CREATE TYPE phase_operatoire    AS ENUM ('A','B','C','D','E');
CREATE TYPE statut_formule      AS ENUM ('BROUILLON','VALIDEE','ARCHIVEE');
CREATE TYPE statut_of           AS ENUM ('BROUILLON','PESEE','FABRICATION','VRAC_LIBERE','CONDITIONNEMENT','CLOTURE','ANNULE');
CREATE TYPE statut_vrac         AS ENUM ('EN_COURS','QUARANTAINE','LIBERE','REJETE');
CREATE TYPE type_mouvement      AS ENUM ('ENTREE_RECEPTION','ENTREE_PRODUCTION','SORTIE_PRODUCTION','SORTIE_VENTE','SORTIE_REBUT','AJUSTEMENT','ANNULATION');
CREATE TYPE type_doc_vente      AS ENUM ('DEVIS','BC','BL','FACTURE');
CREATE TYPE statut_doc          AS ENUM ('BROUILLON','VALIDE','ANNULE');
CREATE TYPE statut_paiement     AS ENUM ('NON_PAYEE','PARTIELLE','SOLDEE');
CREATE TYPE mode_reglement      AS ENUM ('ESPECES','CHEQUE','VIREMENT');
CREATE TYPE statut_cheque       AS ENUM ('RECU','DEPOSE','ENCAISSE','IMPAYE');
CREATE TYPE role_utilisateur    AS ENUM ('OPERATEUR_PRODUCTION','RESPONSABLE_RD_QUALITE','COMMERCIAL','COMPTABILITE','ADMIN');
CREATE TYPE type_charge         AS ENUM ('DIRECTE','INDIRECTE');
CREATE TYPE statut_commande_achat AS ENUM ('BROUILLON','ENVOYEE','RECEPTIONNEE','ANNULEE');

-- ---------------------------------------------------------------------
-- 2. Fonctions transverses
-- ---------------------------------------------------------------------

-- Audit trail : interdiction absolue de supprimer une ligne de tracabilite.
CREATE FUNCTION fn_interdire_suppression() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'AUDIT_TRAIL_SUPPRESSION_INTERDITE: la table % est immuable (id=%). Utiliser une ecriture d''annulation ou d''ajustement tracee.',
    TG_TABLE_NAME, OLD.id
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

-- Immuabilite d'une ecriture de mouvement : seul le rattachement d'annulation
-- peut etre renseigne apres coup.
CREATE FUNCTION fn_mouvement_immuable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.lot_stock_id IS DISTINCT FROM OLD.lot_stock_id
     OR NEW.type_mouvement IS DISTINCT FROM OLD.type_mouvement
     OR NEW.quantite IS DISTINCT FROM OLD.quantite
     OR NEW.cout_unitaire IS DISTINCT FROM OLD.cout_unitaire
     OR NEW.date_mouvement IS DISTINCT FROM OLD.date_mouvement
     OR NEW.utilisateur_id IS DISTINCT FROM OLD.utilisateur_id THEN
    RAISE EXCEPTION
      'AUDIT_TRAIL_MODIFICATION_INTERDITE: un mouvement de stock est immuable (id=%).', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Numerotation metier sequentielle par prefixe et par annee.
CREATE TABLE sequences_metier (
  prefixe  TEXT    NOT NULL,
  annee    INTEGER NOT NULL,
  dernier  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefixe, annee)
);

CREATE FUNCTION prochain_numero(p_prefixe TEXT, p_annee INTEGER, p_largeur INTEGER DEFAULT 5)
RETURNS TEXT AS $$
DECLARE v_valeur INTEGER;
BEGIN
  INSERT INTO sequences_metier (prefixe, annee, dernier)
  VALUES (p_prefixe, p_annee, 1)
  ON CONFLICT (prefixe, annee)
  DO UPDATE SET dernier = sequences_metier.dernier + 1
  RETURNING dernier INTO v_valeur;
  RETURN p_prefixe || '-' || p_annee::TEXT || '-' || LPAD(v_valeur::TEXT, p_largeur, '0');
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION fn_touch_maj() RETURNS trigger AS $$
BEGIN
  NEW.maj_le := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 3. Utilisateurs, RBAC, parametrage, audit
-- ---------------------------------------------------------------------
CREATE TABLE utilisateurs (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  mot_de_passe   TEXT NOT NULL,
  nom_complet    TEXT NOT NULL,
  role           role_utilisateur NOT NULL,
  actif          BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE parametres (
  cle        TEXT PRIMARY KEY,
  valeur     TEXT NOT NULL,
  libelle    TEXT NOT NULL,
  maj_le     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  utilisateur_id BIGINT REFERENCES utilisateurs(id),
  action         TEXT NOT NULL,
  entite         TEXT NOT NULL,
  entite_id      TEXT,
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_entite ON audit_log (entite, entite_id);
CREATE INDEX idx_audit_date   ON audit_log (cree_le DESC);
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

-- ---------------------------------------------------------------------
-- 4. Referentiel articles / fournisseurs
-- ---------------------------------------------------------------------
CREATE TABLE fournisseurs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  raison_sociale  TEXT NOT NULL,
  contact         TEXT,
  telephone       TEXT,
  email           TEXT,
  adresse         TEXT,
  actif           BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE articles_catalogue (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_sku          TEXT NOT NULL UNIQUE,
  designation       TEXT NOT NULL,
  type              type_article NOT NULL,
  unite             TEXT NOT NULL,
  nom_inci          TEXT,
  seuil_critique    NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (seuil_critique >= 0),
  -- valorisation : prix moyen d'achat pondere recalcule a chaque entree
  pamp              NUMERIC(16,4) NOT NULL DEFAULT 0 CHECK (pamp >= 0),
  prix_vente_ht     NUMERIC(16,4) NOT NULL DEFAULT 0 CHECK (prix_vente_ht >= 0),
  tva_pct           NUMERIC(6,3)  NOT NULL DEFAULT 19 CHECK (tva_pct >= 0 AND tva_pct <= 100),
  -- PF uniquement : contenance nominale du conditionnement (ml)
  contenance_ml     NUMERIC(16,3) CHECK (contenance_ml IS NULL OR contenance_ml > 0),
  -- MP achetees au volume : masse volumique (g/ml) pour la conversion masse <-> volume
  densite           NUMERIC(8,4) CHECK (densite IS NULL OR (densite > 0 AND densite <= 5)),
  actif             BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_unite_par_type CHECK (
    (type = 'MP' AND unite IN ('g','kg','L','ml'))
    OR (type IN ('AC','PF') AND unite = 'U')
  ),
  CONSTRAINT chk_contenance_pf CHECK (type = 'PF' OR contenance_ml IS NULL)
);
CREATE INDEX idx_articles_type ON articles_catalogue (type) WHERE actif;
CREATE TRIGGER trg_articles_touch BEFORE UPDATE ON articles_catalogue
  FOR EACH ROW EXECUTE FUNCTION fn_touch_maj();

-- Nomenclature de conditionnement : quels AC pour un PF, et en quelle quantite.
CREATE TABLE nomenclature_ac (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_pf_id   BIGINT NOT NULL REFERENCES articles_catalogue(id) ON DELETE CASCADE,
  article_ac_id   BIGINT NOT NULL REFERENCES articles_catalogue(id),
  qte_par_unite   NUMERIC(16,3) NOT NULL CHECK (qte_par_unite > 0),
  obligatoire     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (article_pf_id, article_ac_id)
);

-- ---------------------------------------------------------------------
-- 5. Formulation (R&D)
-- ---------------------------------------------------------------------
CREATE TABLE formules (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_formule    TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  nom_produit     TEXT NOT NULL,
  densite         NUMERIC(8,4) NOT NULL CHECK (densite > 0 AND densite <= 5),
  statut          statut_formule NOT NULL DEFAULT 'BROUILLON',
  article_pf_id   BIGINT REFERENCES articles_catalogue(id),
  perte_process_pct NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (perte_process_pct >= 0 AND perte_process_pct <= 50),
  ph_min          NUMERIC(6,3) CHECK (ph_min IS NULL OR (ph_min >= 0 AND ph_min <= 14)),
  ph_max          NUMERIC(6,3) CHECK (ph_max IS NULL OR (ph_max >= 0 AND ph_max <= 14)),
  viscosite_min   NUMERIC(16,3),
  viscosite_max   NUMERIC(16,3),
  commentaire     TEXT,
  cree_par        BIGINT REFERENCES utilisateurs(id),
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (code_formule, version),
  CONSTRAINT chk_ph_intervalle CHECK (ph_min IS NULL OR ph_max IS NULL OR ph_min <= ph_max),
  CONSTRAINT chk_visco_intervalle CHECK (viscosite_min IS NULL OR viscosite_max IS NULL OR viscosite_min <= viscosite_max)
);
CREATE TRIGGER trg_formules_touch BEFORE UPDATE ON formules
  FOR EACH ROW EXECUTE FUNCTION fn_touch_maj();

CREATE TABLE formule_lignes (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  formule_id        BIGINT NOT NULL REFERENCES formules(id) ON DELETE CASCADE,
  article_id        BIGINT NOT NULL REFERENCES articles_catalogue(id),
  phase             phase_operatoire NOT NULL,
  pourcentage_w_w   NUMERIC(10,3) NOT NULL,
  consigne          TEXT,
  ordre             INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT chk_pourcentage CHECK (pourcentage_w_w > 0 AND pourcentage_w_w <= 100),
  UNIQUE (formule_id, article_id, phase)
);
CREATE INDEX idx_formule_lignes_formule ON formule_lignes (formule_id);

-- Un ingredient de formule est obligatoirement une matiere premiere.
CREATE FUNCTION fn_formule_ligne_type_mp() RETURNS trigger AS $$
DECLARE v_type type_article;
BEGIN
  SELECT type INTO v_type FROM articles_catalogue WHERE id = NEW.article_id;
  IF v_type <> 'MP' THEN
    RAISE EXCEPTION 'FORMULE_ARTICLE_INVALIDE: seule une matiere premiere (MP) peut figurer dans une formule (article_id=%, type=%).', NEW.article_id, v_type
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_formule_ligne_type BEFORE INSERT OR UPDATE ON formule_lignes
  FOR EACH ROW EXECUTE FUNCTION fn_formule_ligne_type_mp();

-- REGLE METIER NON NEGOCIABLE : somme des pourcentages = 100,000 % exactement.
-- Verification differee en fin de transaction pour autoriser la saisie/remplacement
-- complet du tableau d'ingredients en une seule ecriture atomique.
CREATE FUNCTION fn_controle_somme_formule() RETURNS trigger AS $$
DECLARE
  v_formule_id BIGINT;
  v_somme      NUMERIC(14,3);
  v_nb         INTEGER;
BEGIN
  v_formule_id := COALESCE(NEW.formule_id, OLD.formule_id);
  IF NOT EXISTS (SELECT 1 FROM formules WHERE id = v_formule_id) THEN
    RETURN NULL; -- formule supprimee dans la meme transaction
  END IF;
  SELECT COALESCE(SUM(pourcentage_w_w), 0), COUNT(*) INTO v_somme, v_nb
  FROM formule_lignes WHERE formule_id = v_formule_id;
  IF v_nb > 0 AND v_somme <> 100.000 THEN
    RAISE EXCEPTION
      'FORMULE_SOMME_INVALIDE: la somme ponderale de la formule % est de % %% (attendu exactement 100,000 %%).',
      v_formule_id, v_somme
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ct_formule_somme_100
  AFTER INSERT OR UPDATE OR DELETE ON formule_lignes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_controle_somme_formule();

-- ---------------------------------------------------------------------
-- 6. Receptions, lots de stock, mouvements
-- ---------------------------------------------------------------------
CREATE TABLE receptions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero            TEXT NOT NULL UNIQUE,
  fournisseur_id    BIGINT REFERENCES fournisseurs(id),
  date_reception    DATE NOT NULL DEFAULT CURRENT_DATE,
  reference_bl_fournisseur TEXT,
  commentaire       TEXT,
  cree_par          BIGINT REFERENCES utilisateurs(id),
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_receptions_no_delete BEFORE DELETE ON receptions
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

CREATE TABLE lots_vrac (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_lot_vrac       TEXT NOT NULL UNIQUE,
  of_id               BIGINT NOT NULL,
  formule_id          BIGINT NOT NULL REFERENCES formules(id),
  masse_nette_kg      NUMERIC(16,3) NOT NULL CHECK (masse_nette_kg > 0),
  masse_restante_kg   NUMERIC(16,3) NOT NULL CHECK (masse_restante_kg >= 0),
  statut              statut_vrac NOT NULL DEFAULT 'EN_COURS',
  date_debut_melange  TIMESTAMPTZ,
  date_fin_melange    TIMESTAMPTZ,
  ph_mesure           NUMERIC(6,3),
  viscosite_mesuree   NUMERIC(16,3),
  aspect              TEXT,
  couleur             TEXT,
  odeur               TEXT,
  conforme_organoleptique BOOLEAN,
  commentaire_qualite TEXT,
  cout_total          NUMERIC(18,4) NOT NULL DEFAULT 0,
  libere_par          BIGINT REFERENCES utilisateurs(id),
  libere_le           TIMESTAMPTZ,
  cree_le             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_masse_restante CHECK (masse_restante_kg <= masse_nette_kg)
);
CREATE TRIGGER trg_lots_vrac_no_delete BEFORE DELETE ON lots_vrac
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

CREATE TABLE lots_stock (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id           BIGINT NOT NULL REFERENCES articles_catalogue(id),
  code_lot_interne     TEXT NOT NULL UNIQUE,
  code_lot_fournisseur TEXT,
  reception_id         BIGINT REFERENCES receptions(id),
  fournisseur_id       BIGINT REFERENCES fournisseurs(id),
  -- Un lot de PF est obligatoirement rattache a un lot de vrac libere.
  lot_vrac_id          BIGINT REFERENCES lots_vrac(id),
  of_id                BIGINT,
  qte_initiale         NUMERIC(16,3) NOT NULL CHECK (qte_initiale >= 0),
  qte_actuelle         NUMERIC(16,3) NOT NULL CHECK (qte_actuelle >= 0),
  statut               statut_lot NOT NULL DEFAULT 'QUARANTAINE',
  dluo                 DATE,
  date_reception       DATE NOT NULL DEFAULT CURRENT_DATE,
  date_fabrication     DATE,
  prix_achat_unitaire  NUMERIC(16,4) NOT NULL DEFAULT 0 CHECK (prix_achat_unitaire >= 0),
  frais_approche_unitaire NUMERIC(16,4) NOT NULL DEFAULT 0 CHECK (frais_approche_unitaire >= 0),
  cout_unitaire        NUMERIC(16,4) GENERATED ALWAYS AS (prix_achat_unitaire + frais_approche_unitaire) STORED,
  coa_fichier          TEXT,
  emplacement          TEXT,
  commentaire          TEXT,
  statut_modifie_par   BIGINT REFERENCES utilisateurs(id),
  statut_modifie_le    TIMESTAMPTZ,
  cree_par             BIGINT REFERENCES utilisateurs(id),
  cree_le              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_qte_coherente CHECK (qte_actuelle <= qte_initiale)
);
CREATE INDEX idx_lots_article_statut ON lots_stock (article_id, statut);
-- Index FEFO : lots disponibles tries par date de peremption la plus proche.
CREATE INDEX idx_lots_fefo ON lots_stock (article_id, dluo NULLS LAST, id)
  WHERE statut = 'CONFORME' AND qte_actuelle > 0;
CREATE TRIGGER trg_lots_stock_no_delete BEFORE DELETE ON lots_stock
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();


-- Regle : un lot de produit fini exige un lot de vrac ; un lot MP/AC ne peut
-- pas etre rattache a un vrac.
CREATE FUNCTION fn_lot_pf_exige_vrac() RETURNS trigger AS $$
DECLARE
  v_type   type_article;
  v_statut statut_vrac;
BEGIN
  SELECT type INTO v_type FROM articles_catalogue WHERE id = NEW.article_id;
  IF v_type = 'PF' THEN
    IF NEW.lot_vrac_id IS NULL THEN
      RAISE EXCEPTION 'LOT_PF_SANS_VRAC: un lot de produit fini doit etre rattache a un lot de vrac libere (lot %).', NEW.code_lot_interne
        USING ERRCODE = '23514';
    END IF;
    SELECT statut INTO v_statut FROM lots_vrac WHERE id = NEW.lot_vrac_id;
    IF v_statut <> 'LIBERE' THEN
      RAISE EXCEPTION 'VRAC_NON_LIBERE: le lot de vrac % n''est pas libere par le controle qualite (statut=%).', NEW.lot_vrac_id, v_statut
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.lot_vrac_id IS NOT NULL THEN
    RAISE EXCEPTION 'LOT_VRAC_INTERDIT: seul un lot de produit fini peut referencer un lot de vrac.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_lot_pf_vrac BEFORE INSERT ON lots_stock
  FOR EACH ROW EXECUTE FUNCTION fn_lot_pf_exige_vrac();

-- Journal des mouvements : source de verite immuable du stock.
CREATE TABLE mouvements_stock (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_stock_id      BIGINT NOT NULL REFERENCES lots_stock(id),
  type_mouvement    type_mouvement NOT NULL,
  quantite          NUMERIC(16,3) NOT NULL CHECK (quantite <> 0),
  cout_unitaire     NUMERIC(16,4) NOT NULL DEFAULT 0,
  of_id             BIGINT,
  document_vente_id BIGINT,
  reception_id      BIGINT REFERENCES receptions(id),
  motif             TEXT,
  annule_mouvement_id BIGINT REFERENCES mouvements_stock(id),
  utilisateur_id    BIGINT REFERENCES utilisateurs(id),
  date_mouvement    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mouvements_lot ON mouvements_stock (lot_stock_id, date_mouvement);
CREATE INDEX idx_mouvements_of  ON mouvements_stock (of_id) WHERE of_id IS NOT NULL;
CREATE TRIGGER trg_mouvements_no_delete BEFORE DELETE ON mouvements_stock
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();
CREATE TRIGGER trg_mouvements_immuable BEFORE UPDATE ON mouvements_stock
  FOR EACH ROW EXECUTE FUNCTION fn_mouvement_immuable();

-- Le stock physique d'un lot est toujours le cumul de ses mouvements.
CREATE FUNCTION fn_applique_mouvement() RETURNS trigger AS $$
DECLARE
  v_actuelle NUMERIC(16,3);
  v_code     TEXT;
BEGIN
  SELECT qte_actuelle, code_lot_interne INTO v_actuelle, v_code
    FROM lots_stock WHERE id = NEW.lot_stock_id FOR UPDATE;
  IF v_actuelle IS NULL THEN
    RAISE EXCEPTION 'LOT_INTROUVABLE: lot_stock_id=%', NEW.lot_stock_id USING ERRCODE = '23503';
  END IF;
  IF v_actuelle + NEW.quantite < 0 THEN
    RAISE EXCEPTION 'STOCK_INSUFFISANT: le lot % ne contient que % unite(s), mouvement demande : %.',
      v_code, v_actuelle, NEW.quantite
      USING ERRCODE = '23514';
  END IF;
  UPDATE lots_stock
     SET qte_actuelle = v_actuelle + NEW.quantite,
         qte_initiale = GREATEST(qte_initiale, v_actuelle + NEW.quantite)
   WHERE id = NEW.lot_stock_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_applique_mouvement AFTER INSERT ON mouvements_stock
  FOR EACH ROW EXECUTE FUNCTION fn_applique_mouvement();

-- Une sortie ne peut consommer qu'un lot conforme.
CREATE FUNCTION fn_mouvement_lot_conforme() RETURNS trigger AS $$
DECLARE v_statut statut_lot;
BEGIN
  IF NEW.quantite < 0 AND NEW.type_mouvement IN ('SORTIE_PRODUCTION','SORTIE_VENTE') THEN
    SELECT statut INTO v_statut FROM lots_stock WHERE id = NEW.lot_stock_id;
    IF v_statut <> 'CONFORME' THEN
      RAISE EXCEPTION 'LOT_NON_CONFORME: le lot % est en statut % et ne peut etre consomme.', NEW.lot_stock_id, v_statut
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_mouvement_conforme BEFORE INSERT ON mouvements_stock
  FOR EACH ROW EXECUTE FUNCTION fn_mouvement_lot_conforme();

-- ---------------------------------------------------------------------
-- 7. Ordres de fabrication et dossier de lot electronique
-- ---------------------------------------------------------------------
CREATE TABLE ordres_fabrication (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_of              TEXT NOT NULL UNIQUE,
  formule_id           BIGINT NOT NULL REFERENCES formules(id),
  article_pf_id        BIGINT REFERENCES articles_catalogue(id),
  lot_vrac_id          BIGINT REFERENCES lots_vrac(id),
  masse_cible_kg       NUMERIC(16,3) NOT NULL CHECK (masse_cible_kg > 0),
  surdosage_pct        NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (surdosage_pct >= 0 AND surdosage_pct <= 50),
  masse_brute_kg       NUMERIC(16,3) NOT NULL CHECK (masse_brute_kg > 0),
  unites_pf_cibles     INTEGER CHECK (unites_pf_cibles IS NULL OR unites_pf_cibles > 0),
  statut_of            statut_of NOT NULL DEFAULT 'BROUILLON',
  tolerance_pesee_pct  NUMERIC(6,3) NOT NULL DEFAULT 0.500 CHECK (tolerance_pesee_pct >= 0),
  date_planifiee       DATE,
  date_debut           TIMESTAMPTZ,
  date_cloture         TIMESTAMPTZ,
  -- Elements de cout de revient (valorises a la cloture)
  cout_mp              NUMERIC(18,4) NOT NULL DEFAULT 0,
  cout_ac              NUMERIC(18,4) NOT NULL DEFAULT 0,
  cout_main_oeuvre     NUMERIC(18,4) NOT NULL DEFAULT 0,
  cout_charges_indirectes NUMERIC(18,4) NOT NULL DEFAULT 0,
  heures_production    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (heures_production >= 0),
  unites_produites     INTEGER NOT NULL DEFAULT 0 CHECK (unites_produites >= 0),
  unites_rebut         INTEGER NOT NULL DEFAULT 0 CHECK (unites_rebut >= 0),
  cru                  NUMERIC(18,4),
  rendement_pct        NUMERIC(8,3),
  commentaire          TEXT,
  cree_par             BIGINT REFERENCES utilisateurs(id),
  cree_le              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_of_touch BEFORE UPDATE ON ordres_fabrication
  FOR EACH ROW EXECUTE FUNCTION fn_touch_maj();
CREATE TRIGGER trg_of_no_delete BEFORE DELETE ON ordres_fabrication
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

ALTER TABLE lots_vrac
  ADD CONSTRAINT fk_lots_vrac_of FOREIGN KEY (of_id) REFERENCES ordres_fabrication(id);
ALTER TABLE lots_stock
  ADD CONSTRAINT fk_lots_stock_of FOREIGN KEY (of_id) REFERENCES ordres_fabrication(id);
ALTER TABLE mouvements_stock
  ADD CONSTRAINT fk_mouvements_of FOREIGN KEY (of_id) REFERENCES ordres_fabrication(id);

-- Fiche de fabrication : formule mise a l'echelle, figee a la creation de l'OF.
CREATE TABLE of_lignes_theoriques (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  of_id              BIGINT NOT NULL REFERENCES ordres_fabrication(id) ON DELETE CASCADE,
  article_id         BIGINT NOT NULL REFERENCES articles_catalogue(id),
  phase              phase_operatoire NOT NULL,
  pourcentage_w_w    NUMERIC(10,3) NOT NULL CHECK (pourcentage_w_w > 0 AND pourcentage_w_w <= 100),
  masse_theorique_g  NUMERIC(16,3) NOT NULL CHECK (masse_theorique_g > 0),
  consigne           TEXT,
  ordre              INTEGER NOT NULL DEFAULT 0,
  UNIQUE (of_id, article_id, phase)
);
CREATE INDEX idx_of_lignes_of ON of_lignes_theoriques (of_id);

CREATE TABLE of_pesees_reelles (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  of_id              BIGINT NOT NULL REFERENCES ordres_fabrication(id),
  of_ligne_id        BIGINT NOT NULL REFERENCES of_lignes_theoriques(id),
  lot_stock_id       BIGINT NOT NULL REFERENCES lots_stock(id),
  poids_theorique_g  NUMERIC(16,3) NOT NULL CHECK (poids_theorique_g > 0),
  poids_reel_pesee_g NUMERIC(16,3) NOT NULL CHECK (poids_reel_pesee_g > 0),
  ecart_pct          NUMERIC(10,3) NOT NULL,
  conforme           BOOLEAN NOT NULL,
  -- Une consigne peut etre servie par plusieurs lots (regle FEFO) : la ligne
  -- n'est soldee que par la pesee qui atteint la consigne dans la tolerance,
  -- ou par une acceptation explicite du responsable qualite.
  ligne_terminee     BOOLEAN NOT NULL DEFAULT TRUE,
  valide             BOOLEAN NOT NULL DEFAULT TRUE,
  date_pesee         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operateur_id       BIGINT REFERENCES utilisateurs(id),
  commentaire        TEXT
);
CREATE INDEX idx_pesees_of  ON of_pesees_reelles (of_id);
CREATE INDEX idx_pesees_lot ON of_pesees_reelles (lot_stock_id);
CREATE TRIGGER trg_pesees_no_delete BEFORE DELETE ON of_pesees_reelles
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

-- Une pesee ne peut s'appuyer que sur un lot conforme de l'article attendu.
CREATE FUNCTION fn_pesee_lot_valide() RETURNS trigger AS $$
DECLARE
  v_statut          statut_lot;
  v_article_lot     BIGINT;
  v_article_attendu BIGINT;
  v_dluo            DATE;
BEGIN
  SELECT statut, article_id, dluo INTO v_statut, v_article_lot, v_dluo
    FROM lots_stock WHERE id = NEW.lot_stock_id;
  SELECT article_id INTO v_article_attendu
    FROM of_lignes_theoriques WHERE id = NEW.of_ligne_id;
  IF v_statut IS DISTINCT FROM 'CONFORME' THEN
    RAISE EXCEPTION 'PESEE_LOT_NON_CONFORME: le lot % est en statut % : affectation refusee.', NEW.lot_stock_id, v_statut
      USING ERRCODE = '23514';
  END IF;
  IF v_article_lot <> v_article_attendu THEN
    RAISE EXCEPTION 'PESEE_ARTICLE_INCOHERENT: le lot % ne correspond pas a l''ingredient attendu de la ligne %.', NEW.lot_stock_id, NEW.of_ligne_id
      USING ERRCODE = '23514';
  END IF;
  IF v_dluo IS NOT NULL AND v_dluo < CURRENT_DATE THEN
    RAISE EXCEPTION 'PESEE_LOT_PERIME: le lot % est perime depuis le %.', NEW.lot_stock_id, v_dluo
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pesee_lot_valide BEFORE INSERT ON of_pesees_reelles
  FOR EACH ROW EXECUTE FUNCTION fn_pesee_lot_valide();

-- Consommation des articles de conditionnement.
CREATE TABLE of_conditionnement (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  of_id          BIGINT NOT NULL REFERENCES ordres_fabrication(id),
  article_ac_id  BIGINT NOT NULL REFERENCES articles_catalogue(id),
  lot_stock_id   BIGINT NOT NULL REFERENCES lots_stock(id),
  qte_consommee  NUMERIC(16,3) NOT NULL CHECK (qte_consommee > 0),
  qte_rebut      NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK (qte_rebut >= 0),
  date_operation TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operateur_id   BIGINT REFERENCES utilisateurs(id)
);
CREATE INDEX idx_condi_of ON of_conditionnement (of_id);
CREATE TRIGGER trg_condi_no_delete BEFORE DELETE ON of_conditionnement
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

-- TRIGGER D'INVALIDATION (exige au CDCF) : cloture impossible tant qu'une
-- pesee obligatoire est absente ou non validee.
CREATE FUNCTION fn_controle_cloture_of() RETURNS trigger AS $$
DECLARE
  v_manquantes INTEGER;
  v_libelles   TEXT;
BEGIN
  IF NEW.statut_of = 'CLOTURE' AND OLD.statut_of <> 'CLOTURE' THEN
    SELECT COUNT(*), COALESCE(STRING_AGG(a.code_sku, ', '), '')
      INTO v_manquantes, v_libelles
      FROM of_lignes_theoriques l
      JOIN articles_catalogue a ON a.id = l.article_id
     WHERE l.of_id = NEW.id
       AND NOT EXISTS (
         SELECT 1 FROM of_pesees_reelles p
          WHERE p.of_ligne_id = l.id AND p.valide AND p.ligne_terminee
       );
    IF v_manquantes > 0 THEN
      RAISE EXCEPTION 'PESEES_INCOMPLETES: cloture impossible, % pesee(s) manquante(s) ou non validee(s) : %.', v_manquantes, v_libelles
        USING ERRCODE = '23514';
    END IF;
    IF NEW.lot_vrac_id IS NULL THEN
      RAISE EXCEPTION 'VRAC_MANQUANT: cloture impossible, aucun lot de vrac n''a ete genere pour l''OF %.', NEW.code_of
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_controle_cloture_of BEFORE UPDATE ON ordres_fabrication
  FOR EACH ROW EXECUTE FUNCTION fn_controle_cloture_of();

-- ---------------------------------------------------------------------
-- 8. Achats (reapprovisionnement issu du simulateur de capacite)
-- ---------------------------------------------------------------------
CREATE TABLE commandes_achat (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero         TEXT NOT NULL UNIQUE,
  fournisseur_id BIGINT REFERENCES fournisseurs(id),
  statut         statut_commande_achat NOT NULL DEFAULT 'BROUILLON',
  date_commande  DATE NOT NULL DEFAULT CURRENT_DATE,
  origine        TEXT,
  total_ht       NUMERIC(18,2) NOT NULL DEFAULT 0,
  cree_par       BIGINT REFERENCES utilisateurs(id),
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE commandes_achat_lignes (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commande_id       BIGINT NOT NULL REFERENCES commandes_achat(id) ON DELETE CASCADE,
  article_id        BIGINT NOT NULL REFERENCES articles_catalogue(id),
  quantite          NUMERIC(16,3) NOT NULL CHECK (quantite > 0),
  prix_unitaire     NUMERIC(16,4) NOT NULL DEFAULT 0 CHECK (prix_unitaire >= 0)
);

-- ---------------------------------------------------------------------
-- 9. Clients, chaine documentaire de vente
-- ---------------------------------------------------------------------
CREATE TABLE clients (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  raison_sociale       TEXT NOT NULL,
  categorie_tarif      TEXT NOT NULL DEFAULT 'STANDARD',
  registre_commerce    TEXT,
  nif                  TEXT,
  contact              TEXT,
  telephone            TEXT,
  email                TEXT,
  adresse_facturation  TEXT,
  adresse_livraison    TEXT,
  plafond_credit       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (plafond_credit >= 0),
  delai_paiement_jours INTEGER NOT NULL DEFAULT 0 CHECK (delai_paiement_jours >= 0),
  remise_pct           NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (remise_pct >= 0 AND remise_pct <= 100),
  bloque               BOOLEAN NOT NULL DEFAULT FALSE,
  actif                BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_clients_touch BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION fn_touch_maj();

CREATE TABLE ventes_documents (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_doc            type_doc_vente NOT NULL,
  numero_piece        TEXT NOT NULL UNIQUE,
  client_id           BIGINT NOT NULL REFERENCES clients(id),
  document_parent_id  BIGINT REFERENCES ventes_documents(id),
  date_doc            DATE NOT NULL DEFAULT CURRENT_DATE,
  date_echeance       DATE,
  statut              statut_doc NOT NULL DEFAULT 'BROUILLON',
  statut_paiement     statut_paiement NOT NULL DEFAULT 'NON_PAYEE',
  total_ht            NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_tva           NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_ttc           NUMERIC(18,2) NOT NULL DEFAULT 0,
  montant_paye        NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (montant_paye >= 0),
  marge_brute         NUMERIC(18,2),
  deblocage_par       BIGINT REFERENCES utilisateurs(id),
  deblocage_motif     TEXT,
  reference_externe   TEXT,
  commentaire         TEXT,
  cree_par            BIGINT REFERENCES utilisateurs(id),
  valide_par          BIGINT REFERENCES utilisateurs(id),
  valide_le           TIMESTAMPTZ,
  cree_le             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maj_le              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ventes_client ON ventes_documents (client_id, type_doc, statut);
CREATE INDEX idx_ventes_echeance ON ventes_documents (date_echeance)
  WHERE type_doc = 'FACTURE' AND statut = 'VALIDE';
CREATE TRIGGER trg_ventes_touch BEFORE UPDATE ON ventes_documents
  FOR EACH ROW EXECUTE FUNCTION fn_touch_maj();
CREATE TRIGGER trg_ventes_no_delete BEFORE DELETE ON ventes_documents
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

CREATE TABLE ventes_lignes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id    BIGINT NOT NULL REFERENCES ventes_documents(id) ON DELETE CASCADE,
  article_id     BIGINT NOT NULL REFERENCES articles_catalogue(id),
  lot_pf_id      BIGINT REFERENCES lots_stock(id),
  designation    TEXT NOT NULL,
  quantite       NUMERIC(16,3) NOT NULL CHECK (quantite > 0),
  prix_unitaire  NUMERIC(16,4) NOT NULL CHECK (prix_unitaire >= 0),
  remise_pct     NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (remise_pct >= 0 AND remise_pct <= 100),
  tva_pct        NUMERIC(6,3) NOT NULL DEFAULT 19 CHECK (tva_pct >= 0 AND tva_pct <= 100),
  cout_unitaire  NUMERIC(16,4) NOT NULL DEFAULT 0,
  ordre          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ventes_lignes_doc ON ventes_lignes (document_id);
CREATE INDEX idx_ventes_lignes_lot ON ventes_lignes (lot_pf_id) WHERE lot_pf_id IS NOT NULL;

-- Un bon de livraison exige l'affectation d'un lot physique de produit fini.
CREATE FUNCTION fn_ligne_bl_exige_lot() RETURNS trigger AS $$
DECLARE
  v_type       type_doc_vente;
  v_type_art   type_article;
  v_art_lot    BIGINT;
BEGIN
  SELECT type_doc INTO v_type FROM ventes_documents WHERE id = NEW.document_id;
  IF v_type = 'BL' AND NEW.lot_pf_id IS NULL THEN
    RAISE EXCEPTION 'LOT_PF_OBLIGATOIRE: aucune sortie commerciale n''est possible sans numero de lot de produit fini (ligne %).', NEW.designation
      USING ERRCODE = '23502';
  END IF;
  IF NEW.lot_pf_id IS NOT NULL THEN
    SELECT l.article_id, a.type INTO v_art_lot, v_type_art
      FROM lots_stock l JOIN articles_catalogue a ON a.id = l.article_id
     WHERE l.id = NEW.lot_pf_id;
    IF v_type_art <> 'PF' THEN
      RAISE EXCEPTION 'LOT_VENTE_INVALIDE: seul un lot de produit fini peut etre expedie (lot %).', NEW.lot_pf_id
        USING ERRCODE = '23514';
    END IF;
    IF v_art_lot <> NEW.article_id THEN
      RAISE EXCEPTION 'LOT_ARTICLE_INCOHERENT: le lot % n''appartient pas a l''article facture.', NEW.lot_pf_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ligne_bl_lot BEFORE INSERT OR UPDATE ON ventes_lignes
  FOR EACH ROW EXECUTE FUNCTION fn_ligne_bl_exige_lot();

-- Controle differe a la validation d'un BL : toutes les lignes tracees.
CREATE FUNCTION fn_controle_validation_bl() RETURNS trigger AS $$
DECLARE v_sans_lot INTEGER; v_nb_lignes INTEGER;
BEGIN
  IF NEW.type_doc = 'BL' AND NEW.statut = 'VALIDE' AND OLD.statut <> 'VALIDE' THEN
    SELECT COUNT(*) FILTER (WHERE lot_pf_id IS NULL), COUNT(*)
      INTO v_sans_lot, v_nb_lignes
      FROM ventes_lignes WHERE document_id = NEW.id;
    IF v_nb_lignes = 0 THEN
      RAISE EXCEPTION 'BL_VIDE: impossible de valider un bon de livraison sans ligne.' USING ERRCODE = '23514';
    END IF;
    IF v_sans_lot > 0 THEN
      RAISE EXCEPTION 'LOT_PF_OBLIGATOIRE: % ligne(s) du bon de livraison % sans numero de lot de produit fini.', v_sans_lot, NEW.numero_piece
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_validation_bl BEFORE UPDATE ON ventes_documents
  FOR EACH ROW EXECUTE FUNCTION fn_controle_validation_bl();

-- ---------------------------------------------------------------------
-- 10. Encaissements et recouvrement
-- ---------------------------------------------------------------------
CREATE TABLE encaissements (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero                   TEXT NOT NULL UNIQUE,
  client_id                BIGINT NOT NULL REFERENCES clients(id),
  montant_verse            NUMERIC(18,2) NOT NULL CHECK (montant_verse > 0),
  montant_affecte          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (montant_affecte >= 0),
  mode_reglement           mode_reglement NOT NULL,
  date_reglement           DATE NOT NULL DEFAULT CURRENT_DATE,
  cheque_numero            TEXT,
  cheque_banque            TEXT,
  cheque_date_emission     DATE,
  cheque_date_encaissement_prev DATE,
  cheque_statut            statut_cheque,
  reference                TEXT,
  commentaire              TEXT,
  cree_par                 BIGINT REFERENCES utilisateurs(id),
  cree_le                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cheque_complet CHECK (
    mode_reglement <> 'CHEQUE'
    OR (cheque_numero IS NOT NULL AND cheque_date_emission IS NOT NULL AND cheque_statut IS NOT NULL)
  ),
  CONSTRAINT chk_affectation_max CHECK (montant_affecte <= montant_verse)
);
CREATE TRIGGER trg_encaissements_no_delete BEFORE DELETE ON encaissements
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

-- Affectation multi-factures d'un meme reglement (ou paiement partiel).
CREATE TABLE encaissement_affectations (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encaissement_id   BIGINT NOT NULL REFERENCES encaissements(id),
  document_id       BIGINT NOT NULL REFERENCES ventes_documents(id),
  montant_affecte   NUMERIC(18,2) NOT NULL CHECK (montant_affecte > 0),
  cree_le           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (encaissement_id, document_id)
);
CREATE INDEX idx_affectations_doc ON encaissement_affectations (document_id);
CREATE TRIGGER trg_affectations_no_delete BEFORE DELETE ON encaissement_affectations
  FOR EACH ROW EXECUTE FUNCTION fn_interdire_suppression();

-- ---------------------------------------------------------------------
-- 11. Depenses, personnel, comptabilite analytique
-- ---------------------------------------------------------------------
CREATE TABLE depenses_categories (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  libelle  TEXT NOT NULL,
  type     type_charge NOT NULL
);

CREATE TABLE depenses (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero        TEXT NOT NULL UNIQUE,
  categorie_id  BIGINT NOT NULL REFERENCES depenses_categories(id),
  libelle       TEXT NOT NULL,
  date_depense  DATE NOT NULL DEFAULT CURRENT_DATE,
  montant_ht    NUMERIC(18,2) NOT NULL CHECK (montant_ht >= 0),
  tva_pct       NUMERIC(6,3) NOT NULL DEFAULT 19 CHECK (tva_pct >= 0 AND tva_pct <= 100),
  montant_ttc   NUMERIC(18,2) NOT NULL CHECK (montant_ttc >= 0),
  mode_paiement mode_reglement,
  fournisseur_id BIGINT REFERENCES fournisseurs(id),
  of_id         BIGINT REFERENCES ordres_fabrication(id),
  rapproche     BOOLEAN NOT NULL DEFAULT FALSE,
  piece_jointe  TEXT,
  cree_par      BIGINT REFERENCES utilisateurs(id),
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_depenses_periode ON depenses (date_depense);

CREATE TABLE salaries (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  matricule      TEXT NOT NULL UNIQUE,
  nom            TEXT NOT NULL,
  prenom         TEXT NOT NULL,
  date_naissance DATE,
  fonction       TEXT NOT NULL,
  departement    TEXT NOT NULL,
  type_contrat   TEXT NOT NULL,
  date_embauche  DATE,
  salaire_base   NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (salaire_base >= 0),
  taux_horaire   NUMERIC(16,4) NOT NULL DEFAULT 0 CHECK (taux_horaire >= 0),
  actif          BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pointages (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  salarie_id    BIGINT NOT NULL REFERENCES salaries(id),
  date_jour     DATE NOT NULL,
  heures        NUMERIC(8,2) NOT NULL CHECK (heures > 0 AND heures <= 24),
  departement   TEXT NOT NULL,
  of_id         BIGINT REFERENCES ordres_fabrication(id),
  commentaire   TEXT,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (salarie_id, date_jour, of_id)
);
CREATE INDEX idx_pointages_of ON pointages (of_id) WHERE of_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 12. Vues d'analyse
-- ---------------------------------------------------------------------

-- Stock disponible par article (lots conformes non perimes).
CREATE VIEW v_stock_disponible AS
SELECT a.id                AS article_id,
       a.code_sku,
       a.designation,
       a.type,
       a.unite,
       a.seuil_critique,
       a.pamp,
       COALESCE(SUM(l.qte_actuelle) FILTER (
         WHERE l.statut = 'CONFORME' AND (l.dluo IS NULL OR l.dluo >= CURRENT_DATE)
       ), 0) AS qte_disponible,
       COALESCE(SUM(l.qte_actuelle) FILTER (WHERE l.statut = 'QUARANTAINE'), 0) AS qte_quarantaine,
       COALESCE(SUM(l.qte_actuelle) FILTER (WHERE l.statut = 'BLOQUE'), 0)      AS qte_bloquee,
       COALESCE(SUM(l.qte_actuelle) FILTER (
         WHERE l.statut = 'CONFORME' AND l.dluo IS NOT NULL AND l.dluo < CURRENT_DATE
       ), 0) AS qte_perimee,
       COALESCE(SUM(l.qte_actuelle * l.cout_unitaire) FILTER (WHERE l.statut <> 'REJETE'), 0) AS valeur_stock
  FROM articles_catalogue a
  LEFT JOIN lots_stock l ON l.article_id = a.id
 GROUP BY a.id;

-- Balance agee des creances clients.
CREATE VIEW v_balance_agee AS
SELECT d.id            AS document_id,
       d.numero_piece,
       d.client_id,
       c.raison_sociale,
       d.date_doc,
       d.date_echeance,
       d.total_ttc,
       d.montant_paye,
       (d.total_ttc - d.montant_paye) AS solde_du,
       d.statut_paiement,
       GREATEST(0, CURRENT_DATE - d.date_echeance) AS jours_retard,
       CASE
         WHEN d.date_echeance IS NULL OR d.date_echeance >= CURRENT_DATE THEN 'NON_ECHUE'
         WHEN CURRENT_DATE - d.date_echeance BETWEEN 1 AND 30  THEN 'ECHUE_1_30'
         WHEN CURRENT_DATE - d.date_echeance BETWEEN 31 AND 60 THEN 'ECHUE_31_60'
         ELSE 'ECHUE_PLUS_60'
       END AS tranche
  FROM ventes_documents d
  JOIN clients c ON c.id = d.client_id
 WHERE d.type_doc = 'FACTURE'
   AND d.statut = 'VALIDE'
   AND d.statut_paiement <> 'SOLDEE';

-- Encours client (base du controle de plafond de credit).
CREATE VIEW v_encours_clients AS
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
       ), 0) AS encours_echu
  FROM clients c
  LEFT JOIN ventes_documents d ON d.client_id = c.id
 GROUP BY c.id;
