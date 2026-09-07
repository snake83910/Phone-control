'use client';

/**
 * Client HTTP du navigateur.
 *
 * Toutes les requêtes passent par `/api/proxy`, jamais par l'API directement :
 * les jetons vivent dans des cookies `httpOnly` que ce code ne peut pas lire.
 * C'est volontaire — voir src/lib/server/session.ts.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await fetch(`/api/proxy${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    // Le proxy a déjà tenté la rotation : un 401 ici signifie que la session
    // est réellement terminée.
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login?expired=1';
    }
    throw new ApiError(401, 'Session expirée.');
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = Array.isArray(payload?.message)
      ? payload.message.join(', ')
      : (payload?.message ?? `Erreur ${response.status}`);
    throw new ApiError(response.status, message, payload?.correlationId);
  }

  return payload as T;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  take: number;
  skip: number;
}

// --- Types partagés avec l'API ---------------------------------------------

export interface AdminProfile {
  id: string;
  email: string;
  role: 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'DEPOT_ADMIN' | 'VIEWER';
  companyId: string | null;
  depotScope: string[];
}

export interface DashboardSummary {
  devices: {
    total: number;
    enrolled: number;
    pending: number;
    active: number;
    locked: number;
    returned: number;
    offline: number;
    deviceOwnerUnconfirmed: number;
  };
  users: { active: number; inSession: number };
  sessions: { active: number; returned: number; notReturned: number };
  alerts: {
    open: number;
    today: number;
    bySeverity: Record<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', number>;
  };
  health: { lowBattery: number; gpsDisabled: number };
  generatedAt: string;
}

export interface ActivityPoint {
  day: string;
  sessions: number;
  alerts: number;
}

export interface DeviceSummary {
  id: string;
  assetTag: string;
  manufacturer: string | null;
  model: string | null;
  androidVersion: string | null;
  appVersion: string | null;
  state: 'UNKNOWN' | 'LOCKED' | 'ACTIVE' | 'RETURNED' | 'LOCKING';
  enrollmentStatus: 'PENDING' | 'ENROLLED' | 'REVOKED' | 'DECOMMISSIONED';
  kioskMode: 'KIOSK' | 'RESTRICTED' | 'STANDARD';
  deviceOwnerActive: boolean;
  depot: { id: string; name: string } | null;
  battery: number | null;
  charging: boolean | null;
  gpsEnabled: boolean | null;
  networkType: string | null;
  storageFreeMb: number | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  lastLocation: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    at: string;
  } | null;
  currentSession: {
    id: string;
    startedAt: string;
    state: 'ACTIVE' | 'RETURNED';
    user: { id: string; firstName: string; lastName: string };
  } | null;
}

/**
 * Constat rapporte par le telephone : ce qu'il a REELLEMENT masque.
 *
 * `enforced` a `false` signifie qu'aucune application n'est masquee, quelle que
 * soit la politique demandee — le plus souvent parce que l'application n'est
 * pas administrateur de l'appareil.
 */
export interface AppPolicyReport {
  enforced: boolean;
  configVersion: number;
  hidden: string[];
  refusals: Array<{
    packageName: string;
    reason:
      | 'SELF'
      | 'PROTECTED'
      | 'NOT_INSTALLED'
      | 'CONFLICT'
      | 'SYSTEM_REFUSED';
  }>;
  appliedAt: string | null;
}

export interface DeviceDetail extends DeviceSummary {
  settings: Record<string, unknown>;
  appPolicy: AppPolicyReport | null;
}

export interface UserSummary {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  depot: { id: string; name: string } | null;
  badge: { id: string; maskedBarcode: string } | null;
}

export interface UserDetail {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber: string | null;
  phone: string | null;
  email: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  depot: { id: string; name: string } | null;
  badges: Array<{
    id: string;
    maskedBarcode: string;
    barcodeType: string;
    status: string;
    issuedAt: string;
    revokedAt: string | null;
  }>;
  authorizedDevices: Array<{ id: string; assetTag: string; state: string }>;
  lastSession: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    status: string;
    device: { id: string; assetTag: string };
  } | null;
}

export interface BadgeRow {
  id: string;
  userId: string;
  maskedBarcode: string;
  barcodeLast4: string;
  barcodeType: string;
  status: 'ACTIVE' | 'INACTIVE' | 'REVOKED' | 'LOST';
  issuedAt: string;
  revokedAt: string | null;
  offlineCapable: boolean;
  user?: { id: string; firstName: string; lastName: string; status: string };
}

export interface DepotRow {
  id: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  exitHysteresisMeters: number;
  timezone: string;
  returnTime: string;
  lockTime: string;
  operationalDayStart: string;
  status: string;
  _count?: { devices: number; users: number };
}

export interface DepotDetail extends DepotRow {
  scheduleOverrides: Record<string, unknown>;
  today: {
    operationalDay: string;
    rules: { returnTime: string | null; lockTime: string | null };
    returnInstant: string | null;
    nextLockInstant: string | null;
  };
}

export interface AlertRow {
  id: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'AUTO_CLOSED';
  title: string;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  context: Record<string, unknown>;
  device: { id: string; assetTag: string } | null;
  user: { id: string; firstName: string; lastName: string } | null;
  depot: { id: string; name: string } | null;
}

export interface LivePosition {
  deviceId: string;
  assetTag: string;
  state: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  at: string;
  batteryLevel: number | null;
  isOffline: boolean;
  depot: { id: string; name: string } | null;
  user: { id: string; firstName: string; lastName: string } | null;
  sessionState: string | null;
}

export interface SessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  expiresAt: string;
  status: string;
  state: string;
  returnedAt: string | null;
  endReason: string | null;
  openedOffline: boolean;
  user: { id: string; firstName: string; lastName: string };
  device: { id: string; assetTag: string };
  depot: { id: string; name: string } | null;
}

export interface SecurityEventRow {
  id: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  occurredAt: string;
  metadata: Record<string, unknown>;
  device: { id: string; assetTag: string } | null;
  user: { id: string; firstName: string; lastName: string } | null;
}

export interface ScanEventRow {
  id: string;
  result: string;
  scannedAt: string;
  offline: boolean;
  barcodeLast4: string | null;
  device: { id: string; assetTag: string } | null;
  user: { id: string; firstName: string; lastName: string } | null;
}

export interface AuditLogRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  correlationId: string | null;
  createdAt: string;
  admin: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
}
