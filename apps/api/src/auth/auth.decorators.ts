import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AdminRole } from '@prisma/client';

export const AUTH_KIND = 'auth:kind';
export const ROLES_KEY = 'auth:roles';

export type AuthKind = 'public' | 'admin' | 'device';

/** Route accessible sans authentification (connexion, santé, rafraîchissement). */
export const Public = () => SetMetadata(AUTH_KIND, 'public' as AuthKind);

/** Route appelée par un téléphone enrôlé, authentifié par jeton d'appareil. */
export const DeviceAuth = () => SetMetadata(AUTH_KIND, 'device' as AuthKind);

/** Rôles autorisés. Sans ce décorateur, tout administrateur authentifié passe. */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthenticatedAdmin {
  id: string;
  companyId: string | null;
  role: AdminRole;
  depotScope: string[];
  email: string;
}

export interface AuthenticatedDevice {
  id: string;
  companyId: string;
  depotId: string | null;
}

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
    const req = ctx.switchToHttp().getRequest<{ admin?: AuthenticatedAdmin }>();
    if (!req.admin) {
      throw new Error(
        'CurrentAdmin utilisé sur une route qui n\'est pas protégée par l\'authentification administrateur.',
      );
    }
    return req.admin;
  },
);

export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedDevice => {
    const req = ctx.switchToHttp().getRequest<{ device?: AuthenticatedDevice }>();
    if (!req.device) {
      throw new Error(
        'CurrentDevice utilisé sur une route qui n\'est pas protégée par l\'authentification appareil.',
      );
    }
    return req.device;
  },
);
