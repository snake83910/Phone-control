import { ProvisioningError } from '@phone-control/provisioning-payload';

/**
 * Client de l'API Phone Control, réduit à ce dont l'atelier a besoin.
 *
 * Volontairement écrit à la main plutôt que généré : quatre routes, aucune
 * dépendance, et des messages d'erreur rédigés pour quelqu'un qui a un carton
 * de téléphones devant lui, pas pour un développeur.
 */

export interface DepotSummary {
  id: string;
  name: string;
}

export interface DeviceSummary {
  id: string;
  assetTag: string;
  depot?: { id: string; name: string } | null;
  enrollmentStatus?: string;
  state?: string;
}

export interface EnrollmentTokenResult {
  id: string;
  token: string;
  expiresAt: string;
}

interface ListResponse<T> {
  items: T[];
  total: number;
}

const PAGE_SIZE = 200; // maximum accepté par l'API (PaginationDto)

export class ApiClient {
  private accessToken?: string;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Identité de l'administrateur connecté, pour l'affichage et la traçabilité. */
  private profile?: { email: string; role: string; companyId?: string | null };

  get admin(): { email: string; role: string } | undefined {
    return this.profile;
  }

  async login(email: string, password: string): Promise<void> {
    const response = await this.request<{
      accessToken: string;
      admin: { email: string; role: string; companyId?: string | null };
    }>('POST', '/v1/auth/login', { email, password }, { authenticated: false });

    this.accessToken = response.accessToken;
    this.profile = response.admin;
  }

  async listDepots(): Promise<DepotSummary[]> {
    const depots = await this.request<DepotSummary[]>('GET', '/v1/depots');
    return depots.map((depot) => ({ id: depot.id, name: depot.name }));
  }

  /** Parc complet, page par page : un atelier peut dépasser 200 téléphones. */
  async listDevices(): Promise<DeviceSummary[]> {
    const devices: DeviceSummary[] = [];
    let skip = 0;

    for (;;) {
      const page = await this.request<ListResponse<DeviceSummary>>(
        'GET',
        `/v1/devices?take=${PAGE_SIZE}&skip=${skip}`,
      );
      devices.push(...page.items);
      skip += page.items.length;
      if (page.items.length === 0 || devices.length >= page.total) break;
    }

    return devices;
  }

  async createDevice(input: {
    assetTag: string;
    depotId?: string;
    kioskMode?: string;
  }): Promise<DeviceSummary> {
    return this.request<DeviceSummary>('POST', '/v1/devices', input);
  }

  async createEnrollmentToken(deviceId: string): Promise<EnrollmentTokenResult> {
    return this.request<EnrollmentTokenResult>(
      'POST',
      `/v1/devices/${deviceId}/enrollment-token`,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { authenticated?: boolean } = {},
  ): Promise<T> {
    const authenticated = options.authenticated ?? true;

    if (authenticated && !this.accessToken) {
      throw new ProvisioningError("Appel à l'API sans authentification préalable.");
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) headers.Authorization = `Bearer ${this.accessToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const cause = (error as Error).name === 'AbortError'
        ? `délai de ${this.timeoutMs} ms dépassé`
        : (error as Error).message;
      throw new ProvisioningError(
        `L'API ne répond pas (${method} ${path}) : ${cause}.`,
        `Vérifiez que ${this.baseUrl} est joignable depuis ce poste.`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      throw new ProvisioningError(
        `${method} ${path} — ${response.status} : ${describeError(parsed, text)}`,
        hintFor(response.status),
      );
    }

    return parsed as T;
  }
}

function describeError(parsed: unknown, fallback: string): string {
  if (parsed && typeof parsed === 'object') {
    const message = (parsed as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(' ; ');
  }
  return fallback.slice(0, 300) || 'réponse vide';
}

function hintFor(status: number): string | undefined {
  if (status === 401) {
    return "Identifiants refusés. Vérifiez PC_ADMIN_PASSWORD et l'adresse de l'API.";
  }
  if (status === 403) {
    return 'Ce compte n’a pas le droit de créer des téléphones ou des jetons ' +
      '(rôles autorisés : SUPER_ADMIN, COMPANY_ADMIN, DEPOT_ADMIN).';
  }
  if (status === 409) {
    return "Une ressource du même nom existe déjà : relancez avec le parc à jour.";
  }
  return undefined;
}
