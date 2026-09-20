import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/crypto/token.service';
import { newId } from '../src/common/ids';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Amorçage d'une installation de production : le super-administrateur, et
 * rien d'autre.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────
 * Le runbook prescrivait `seed.ts` pour créer le premier compte. Or ce
 * fichier annonce en première ligne « Jeu de données de démonstration » : il
 * crée aussi « Transports Démo », un dépôt à Marseille, quatre téléphones et
 * trois badges. Constaté sur la vraie base, à la mise en service : un
 * serveur de production venait de naître avec une flotte fictive dedans.
 *
 * Séparer les deux vaut mieux qu'un drapeau dans le seed de démonstration.
 * Un drapeau se lit après coup, et on découvre son sens quand il est trop
 * tard ; deux fichiers aux noms explicites ne se confondent pas.
 *
 * ── Deux refus délibérés ────────────────────────────────────────────────
 * Ce script **exige** que l'adresse et le mot de passe soient fournis. Le
 * seed de démonstration se rabat sur `ChangeMe!2026`, ce qui est sans
 * conséquence sur un poste de développement et inacceptable sur une machine
 * qui vient d'être exposée à Internet.
 *
 * Et il **n'imprime jamais le mot de passe**. Celui du seed a fini dans une
 * transcription de conversation le jour de la mise en service ; l'exploitant
 * qui lance ce script le connaît déjà, puisque c'est lui qui l'a posé.
 */
async function main(): Promise<void> {
  const logger = new Logger('Amorcage');

  const email = process.env.SEED_SUPER_ADMIN_EMAIL;
  const motDePasse = process.env.SEED_SUPER_ADMIN_PASSWORD;

  if (!email || !motDePasse) {
    logger.error(
      'SEED_SUPER_ADMIN_EMAIL et SEED_SUPER_ADMIN_PASSWORD sont requis. ' +
        "Aucune valeur par défaut n'est appliquée : un mot de passe connu de " +
        'tous sur une machine exposée est pire que pas de compte du tout.',
    );
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);

  await TenantContext.system(async () => {
    const passwordHash = await tokens.hashPassword(motDePasse);

    // `upsert` et non `create` : relancer l'amorçage doit être sans danger.
    // C'est le geste réflexe quand on a perdu l'accès, et il ne doit pas
    // échouer sur une contrainte d'unicité au pire moment.
    const avant = await prisma.raw.admin.findUnique({
      where: { email },
      select: { id: true },
    });

    await prisma.raw.admin.upsert({
      where: { email },
      update: { passwordHash },
      create: {
        id: newId(),
        email,
        passwordHash,
        firstName: 'Super',
        lastName: 'Admin',
        role: AdminRole.SUPER_ADMIN,
        // Le super-administrateur n'appartient à aucune entreprise : c'est ce
        // qui lui ouvre le mode inter-entreprises du contexte d'accès.
        companyId: null,
        depotScope: [],
      },
    });

    logger.log(
      avant
        ? `Mot de passe du super-administrateur ${email} remplacé.`
        : `Super-administrateur ${email} créé.`,
    );
    logger.log(
      'Aucune entreprise, aucun téléphone, aucun badge : ce compte crée les ' +
        'entreprises, il ne pilote pas de flotte.',
    );
  });

  await app.close();
}

main().catch((e) => {
  new Logger('Amorcage').error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
