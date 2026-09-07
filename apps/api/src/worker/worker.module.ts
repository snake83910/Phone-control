import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AlertsModule } from '../alerts/alerts.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionsModule } from '../sessions/sessions.module';
import { DevicesModule } from '../devices/devices.module';
import { LeaderLock } from './leader-lock';
import { LockSchedulerJob } from './lock-scheduler.job';
import { HealthMonitorJob } from './health-monitor.job';
import { MaintenanceJob } from './maintenance.job';

/**
 * Tâches planifiées.
 *
 * **Écart assumé par rapport à docs/08** : la Phase 1 prévoyait BullMQ et un
 * paquet `apps/worker` distinct. À l'implémentation, ni l'un ni l'autre ne se
 * justifie :
 *
 *  - il n'y a **aucun travail soumis par un utilisateur** à mettre en file, mais
 *    seulement des balayages périodiques. La file durable existe déjà, et c'est
 *    la table `device_commands`, avec ses statuts, ses tentatives et ses délais
 *    d'expiration. Ajouter BullMQ créerait une seconde file à surveiller pour
 *    un besoin déjà couvert ;
 *  - un paquet séparé imposerait de dupliquer Prisma, la configuration et le
 *    contexte multi-entreprises, ou de bricoler des imports entre paquets.
 *
 * Ce module reste néanmoins **exécutable en processus séparé** (`worker-main.ts`)
 * pour que le pic de 22 h ne dégrade pas la disponibilité de l'API, comme prévu
 * en docs/02 §1. L'exécution unique entre répliques est garantie par un verrou
 * Redis, pas par la structure du déploiement.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    AlertsModule,
    SettingsModule,
    SessionsModule,
    DevicesModule,
  ],
  providers: [LeaderLock, LockSchedulerJob, HealthMonitorJob, MaintenanceJob],
  exports: [LockSchedulerJob, HealthMonitorJob, MaintenanceJob],
})
export class WorkerModule {}
