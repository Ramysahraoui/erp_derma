-- =====================================================================
-- Securite des comptes : changement de mot de passe impose a la premiere
-- connexion (compte administrateur cree a l'installation, comptes crees
-- par l'administrateur pour les utilisateurs).
-- =====================================================================
ALTER TABLE utilisateurs
  ADD COLUMN doit_changer_mot_de_passe BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN derniere_connexion TIMESTAMPTZ;
