import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La racine de compilation de l'API.
 *
 * ── La panne que ce fichier empêche ─────────────────────────────────────
 * `package.json` lance `node dist/main.js`. Ce chemin ne tient que si `src`
 * est la SEULE racine de la compilation de production : dès qu'un second
 * dossier de sources `.ts` y entre, TypeScript remonte la racine commune au
 * dossier du paquet et émet `dist/src/main.js`. Le démarrage échoue alors sur
 * `MODULE_NOT_FOUND`.
 *
 * Ce qui rend la panne coûteuse, c'est qu'elle est MUETTE à la construction :
 * `nest build` réussit, l'image se fabrique, se pousse, se déploie — et c'est
 * le conteneur qui redémarre en boucle, en production.
 *
 * Vécu deux fois. La première, avec `scripts/charge.ts`. La seconde avec
 * `prisma/amorcage.ts`, alors que `prisma/seed.ts` était exclu *par son nom* :
 * l'exclusion nominative ne protège que les fichiers déjà écrits, et le
 * nouveau venu est passé à côté.
 */

const dossierApi = join(__dirname, '..', '..');

/**
 * Les tsconfig portent des commentaires : `JSON.parse` s'y refuse.
 *
 * Seules les lignes ENTIÈREMENT commentées sont retirées. Retirer aussi les
 * commentaires de bloc demanderait de reconnaître `/*`, qui apparaît ici dans
 * des valeurs — `"@/*"`, `"src/**\/*"` — et la recherche du `*\/` fermant
 * dévorerait la moitié du fichier. Ces deux fichiers n'utilisent que `//`.
 */
function lireJsonc(chemin: string): Record<string, unknown> {
  const brut = readFileSync(chemin, 'utf-8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(brut) as Record<string, unknown>;
}

describe('racine de compilation de production', () => {
  const base = lireJsonc(join(dossierApi, 'tsconfig.json'));
  const build = lireJsonc(join(dossierApi, 'tsconfig.build.json'));

  const inclus = (base.include as string[]) ?? [];
  const exclus = (build.exclude as string[]) ?? [];

  /** Le premier segment de `prisma/**\/*.ts` : le dossier racine. */
  const racines = [...new Set(inclus.map((motif) => motif.split('/')[0]))];

  it('n’inclut que `src` hors des dossiers explicitement écartés', () => {
    // Le coeur du garde-fou. Chaque racine de `include` autre que `src` doit
    // être écartée de la construction, SOUS SON NOM DE DOSSIER — pas sous le
    // nom d'un fichier qu'elle contient, puisque c'est précisément ce qui a
    // laissé passer `prisma/amorcage.ts`.
    const manquantes = racines.filter((r) => r !== 'src' && !exclus.includes(r));
    expect(manquantes).toEqual([]);
  });

  it('n’écarte aucun dossier fichier par fichier', () => {
    // Une entrée comme `prisma/seed.ts` donne l'illusion d'une exclusion :
    // elle couvre un fichier, le dossier reste une racine dès qu'un voisin
    // apparaît.
    const nominatives = exclus.filter(
      (e) => e.endsWith('.ts') && !e.startsWith('**/') && e.includes('/'),
    );
    expect(nominatives).toEqual([]);
  });

  it('démarre bien sur `dist/main.js`', () => {
    // Si quelqu'un « répare » un jour la panne en changeant le chemin de
    // démarrage plutôt que la racine, ce test le lui dira : `dist/src/main.js`
    // emporterait aussi `dist/prisma` et `dist/scripts` dans l'image livrée.
    const pkg = JSON.parse(
      readFileSync(join(dossierApi, 'package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe('node dist/main.js');
  });
});
