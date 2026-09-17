-- Authentification unique depuis Trajelys.
--
-- Un DSP chez Trajelys et une Company ici sont la même entreprise, mais rien
-- ne les reliait. Le lien est posé EXPLICITEMENT par l'exploitant à la vente
-- du module : sans cela, n'importe quel titulaire d'un compte Supabase
-- pourrait se provisionner une entreprise.
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "trajelys_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "trajelys_dsp_id" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "companies_trajelys_user_id_key"
  ON "companies" ("trajelys_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "companies_trajelys_dsp_id_key"
  ON "companies" ("trajelys_dsp_id");

-- Les administrateurs créés par authentification unique n'ont pas de mot de
-- passe. `sso_only` l'interdit explicitement plutôt que de s'en remettre au
-- fait qu'un hachage aléatoire ne se devine pas : c'est la vérification que
-- le code fait, et elle doit être lisible.
ALTER TABLE "admins"
  ADD COLUMN IF NOT EXISTS "trajelys_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "sso_only" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "admins_trajelys_user_id_key"
  ON "admins" ("trajelys_user_id");
