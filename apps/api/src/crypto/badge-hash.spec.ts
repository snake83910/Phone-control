import { ConfigService } from '@nestjs/config';
import {
  BadgeHashService,
  BadgeNormalizationError,
  maskBarcode,
  normalizeBarcode,
} from './badge-hash.service';

/**
 * Normalisation des badges — règle FIGÉE (version 1).
 *
 * Ces tests ne protègent pas seulement contre une régression : ils documentent
 * un contrat irréversible. Changer la normalisation rendrait introuvables tous
 * les badges déjà enregistrés, puisque le hachage n'est pas inversible.
 */
describe('normalizeBarcode (v1)', () => {
  it('accepte le format cible : 8 chiffres', () => {
    expect(normalizeBarcode('14557719')).toBe('14557719');
  });

  it.each([
    [' 14557719 ', 'espaces autour'],
    ['14557719\r\n', 'retour chariot du scanner'],
    ['1455-7719', 'tiret de lisibilité'],
    ['14 55 77 19', 'espaces internes'],
    ['1455.7719', 'point'],
  ])('tolère %s (%s)', (input) => {
    expect(normalizeBarcode(input)).toBe('14557719');
  });

  it('passe en majuscules les valeurs alphanumériques', () => {
    expect(normalizeBarcode('ab12cd34')).toBe('AB12CD34');
  });

  it('CONSERVE les zéros de tête', () => {
    // Point critique : « 01455771 » et « 1455771 » sont deux badges distincts.
    // Les traiter comme identiques ouvrirait un accès à un autre chauffeur.
    expect(normalizeBarcode('01455771')).toBe('01455771');
    expect(normalizeBarcode('01455771')).not.toBe(normalizeBarcode('1455771'));
  });

  it('refuse une valeur trop courte ou trop longue', () => {
    expect(() => normalizeBarcode('123')).toThrow(BadgeNormalizationError);
    expect(() => normalizeBarcode('1'.repeat(33))).toThrow(BadgeNormalizationError);
  });

  it('refuse une valeur vide après nettoyage', () => {
    expect(() => normalizeBarcode('---')).toThrow(BadgeNormalizationError);
  });
});

describe('maskBarcode', () => {
  it('ne laisse apparaître que les quatre derniers caractères', () => {
    expect(maskBarcode('7719', 8)).toBe('****7719');
    expect(maskBarcode('6789', 10)).toBe('******6789');
  });

  it('ne produit pas de masque négatif sur une valeur courte', () => {
    expect(maskBarcode('7719', 4)).toBe('7719');
  });
});

describe('BadgeHashService', () => {
  function build(pepper = 'poivre-de-test-0123456789'): BadgeHashService {
    const config = {
      getOrThrow: (key: string) =>
        key === 'BADGE_HMAC_PEPPER' ? pepper : 'cle-maitresse-de-test-0123',
      get: () => 1,
    } as unknown as ConfigService;
    return new BadgeHashService(config);
  }

  it('produit la même empreinte pour toutes les variantes de lecture', () => {
    const service = build();
    const reference = service.hash('14557719');
    for (const variant of [' 14557719', '1455-7719', '14 55 77 19']) {
      expect(service.hash(variant).equals(reference)).toBe(true);
    }
  });

  it('produit des empreintes différentes pour des badges différents', () => {
    const service = build();
    expect(service.hash('14557719').equals(service.hash('14557718'))).toBe(false);
  });

  it('le poivre change l’empreinte : une fuite de base ne suffit pas', () => {
    const a = build('poivre-a-0123456789012345');
    const b = build('poivre-b-0123456789012345');
    expect(a.hash('14557719').equals(b.hash('14557719'))).toBe(false);
  });

  it('describe expose ce qu’il faut stocker, et rien de plus', () => {
    const service = build();
    const described = service.describe('  1455-7719 ');

    expect(described.normalized).toBe('14557719');
    expect(described.last4).toBe('7719');
    expect(described.length).toBe(8);
    expect(described.hashVersion).toBe(1);
    expect(described.hash).toHaveLength(32); // SHA-256
  });

  it('dérive une clé distincte par appareil', () => {
    const service = build();
    const keyA = service.deriveDeviceKey('11111111-1111-7111-8111-111111111111');
    const keyB = service.deriveDeviceKey('22222222-2222-7222-8222-222222222222');

    expect(keyA).toHaveLength(32);
    expect(keyA.equals(keyB)).toBe(false);

    // Déterministe : la même clé peut être régénérée à chaque synchronisation.
    expect(
      service
        .deriveDeviceKey('11111111-1111-7111-8111-111111111111')
        .equals(keyA),
    ).toBe(true);
  });

  it('l’empreinte hors ligne d’un badge diffère d’un appareil à l’autre', () => {
    const service = build();
    const keyA = service.deriveDeviceKey('11111111-1111-7111-8111-111111111111');
    const keyB = service.deriveDeviceKey('22222222-2222-7222-8222-222222222222');

    const hashA = service.deviceScopedHash(keyA, '14557719');
    const hashB = service.deviceScopedHash(keyB, '14557719');

    // C'est ce qui rend inexploitable une liste extraite d'un téléphone volé.
    expect(hashA).not.toBe(hashB);
    // Et la valeur du badge n'apparaît nulle part dans l'empreinte.
    expect(hashA).not.toContain('14557719');
  });
});
