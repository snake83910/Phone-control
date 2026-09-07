import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedAdmin } from '../auth/auth.decorators';

/**
 * Entreprise de l'administrateur, ou un refus explicite.
 *
 * Un SUPER_ADMIN n'est rattache a aucune entreprise : son `companyId` vaut
 * `null`. Les routes metier, elles, en exigent une — il n'y a pas de « tous les
 * telephones » qui ait un sens hors d'une entreprise.
 *
 * Ce controle existe parce que ces routes ecrivaient `admin.companyId!`, une
 * assertion qui ment au compilateur. Le resultat n'etait pas un message clair
 * mais une erreur 500 remontee de Prisma — sur la page d'accueil, c'est-a-dire
 * a la toute premiere connexion apres une installation neuve, ou le seul compte
 * existant est justement le super-administrateur.
 *
 * Un 400 qui dit quoi faire vaut mieux qu'un 500 qui dit qu'il y a un bug.
 */
export function requireCompany(admin: AuthenticatedAdmin): string {
  if (admin.companyId) return admin.companyId;

  throw new BadRequestException(
    'Ce compte n’est rattaché à aucune entreprise. Un super-administrateur ' +
      'crée les entreprises et leurs administrateurs, mais ne pilote pas de ' +
      'flotte lui-même : connectez-vous avec un compte d’entreprise pour ' +
      'accéder à cet écran.',
  );
}
