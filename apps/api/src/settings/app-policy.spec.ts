import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTECTED_PACKAGES } from './app-policy.controller';

/**
 * Parité de la liste protégée entre le serveur et le téléphone.
 *
 * Le serveur refuse la saisie, le téléphone refuse l'application : deux
 * barrières délibérément redondantes. Le danger n'est pas qu'une des deux
 * manque, c'est qu'elles **divergent**. Un serveur plus permissif que le
 * téléphone produirait un tableau de bord affichant un blocage accepté et des
 * appareils qui le refusent en silence — exactement la classe de mensonge que
 * la spécification §67 interdit.
 *
 * Le fichier partagé arbitre. Le côté Kotlin s'y compare de la même façon,
 * dans `AppPolicyRulesTest`.
 */
describe('Politique d’applications — liste protégée', () => {
  const shared = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../packages/state-machine-spec/scenarios/app-policy.json',
      ),
      'utf8',
    ),
  ) as { protectedPackages: string[] };

  it('correspond exactement au fichier partagé', () => {
    expect([...PROTECTED_PACKAGES].sort()).toEqual(
      [...shared.protectedPackages].sort(),
    );
  });

  it('couvre ce qui tient le téléphone debout', () => {
    // Ces cinq-là ne sont pas des exemples : masquer l'un d'eux rend le
    // téléphone irrécupérable à distance, ce qui signifie un déplacement par
    // appareil.
    for (const pkg of [
      'android',
      'com.android.systemui',
      'com.android.phone',
      'com.google.android.gms',
      'com.android.packageinstaller',
    ]) {
      expect(PROTECTED_PACKAGES.has(pkg)).toBe(true);
    }
  });

  it('n’est pas vide', () => {
    // Une liste vidée par mégarde passerait les deux tests précédents si eux
    // aussi étaient vidés. Celui-ci garde une valeur plancher.
    expect(PROTECTED_PACKAGES.size).toBeGreaterThanOrEqual(10);
  });
});
