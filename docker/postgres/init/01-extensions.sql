-- Extensions requises par le schéma Phone Control.
-- Exécuté une seule fois, à la création du volume PostgreSQL.

-- Recherche insensible à la casse pour les e-mails et les slugs.
CREATE EXTENSION IF NOT EXISTS citext;

-- pgcrypto fournit gen_random_uuid() (UUID v4).
-- Les identifiants applicatifs sont des UUID v7 générés côté Node ; cette
-- extension ne sert que de repli pour les valeurs par défaut en base.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- PostGIS : l'extension est activée dès maintenant afin qu'aucune migration
-- ultérieure ne dépende d'un privilège superutilisateur. Les colonnes
-- geography(Point,4326) et les index GiST seront ajoutés en Phase 3, quand la
-- carte du dashboard en aura réellement besoin (cf. docs/03-modele-de-donnees.md).
CREATE EXTENSION IF NOT EXISTS postgis;
