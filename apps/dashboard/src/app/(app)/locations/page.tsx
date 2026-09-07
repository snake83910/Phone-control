'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import maplibregl, { Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api, type DepotRow, type LivePosition } from '@/lib/api';
import { Badge, Card, EmptyState, PageHeader, deviceStateTone } from '@/components/ui';
import { deviceStateLabel, formatAge, fullName } from '@/lib/format';

/**
 * Carte de la flotte.
 *
 * Le fond de carte est **configurable** (`NEXT_PUBLIC_MAP_STYLE_URL`).
 *
 * À défaut, le style de démonstration MapLibre est utilisé : il ne montre que
 * les contours des pays, sans rues ni bâtiments. C'est suffisant pour valider
 * l'application, mais **inexploitable en production** — reconnaître qu'un
 * téléphone est sorti d'un dépôt suppose de voir la voirie. Trois options, à
 * arbitrer avec le client :
 *
 *  - un fournisseur de tuiles (MapTiler, Stadia…) : une clé d'API, un coût à
 *    l'affichage, et les coordonnées des salariés transitent par ce tiers ;
 *  - un serveur de tuiles auto-hébergé à partir d'un extrait OpenStreetMap :
 *    aucune donnée ne sort, mais il faut l'exploiter ;
 *  - un fond raster OpenStreetMap standard, dont la politique d'usage interdit
 *    les usages intensifs.
 *
 * Le troisième point du premier choix n'est pas un détail : la carte affiche
 * des données personnelles de géolocalisation.
 */
const STYLE_URL =
  process.env.NEXT_PUBLIC_MAP_STYLE_URL ??
  'https://demotiles.maplibre.org/style.json';

function markerColor(position: LivePosition): string {
  if (position.isOffline) return 'var(--color-idle)';
  if (position.sessionState === 'RETURNED') return 'var(--color-accent)';
  if (position.state === 'ACTIVE') return 'var(--color-ok)';
  return 'var(--color-ink-faint)';
}

export default function LocationsPage() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const positions = useQuery({
    queryKey: ['live-positions'],
    queryFn: () => api<LivePosition[]>('/v1/locations/live'),
    refetchInterval: 60_000,
  });

  const depots = useQuery({
    queryKey: ['depots', 'list'],
    queryFn: () => api<DepotRow[]>('/v1/depots'),
  });

  // Initialisation unique de la carte.
  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: STYLE_URL,
      center: [5.36978, 43.296482],
      zoom: 5,
      attributionControl: { compact: true },
    });
    instance.addControl(new maplibregl.NavigationControl({}), 'top-right');
    instance.on('load', () => setReady(true));
    map.current = instance;

    return () => {
      instance.remove();
      map.current = null;
      markers.current.clear();
    };
  }, []);

  // Cercles des dépôts : le rayon du geofence doit être visible, sinon une
  // alerte de sortie n'a aucun contexte.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready || !depots.data) return;

    const features = depots.data.map((depot) => ({
      type: 'Feature' as const,
      properties: { name: depot.name, radius: depot.radiusMeters },
      geometry: {
        type: 'Point' as const,
        coordinates: [depot.longitude, depot.latitude],
      },
    }));

    const data = { type: 'FeatureCollection' as const, features };

    if (instance.getSource('depots')) {
      (instance.getSource('depots') as maplibregl.GeoJSONSource).setData(data);
      return;
    }

    instance.addSource('depots', { type: 'geojson', data });
    instance.addLayer({
      id: 'depots-circle',
      type: 'circle',
      source: 'depots',
      paint: {
        // Le rayon en pixels dépend du zoom : approximation suffisante pour
        // situer la zone, la décision fait foi côté téléphone de toute façon.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 16, 60],
        'circle-color': '#1d4ed8',
        'circle-opacity': 0.12,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#1d4ed8',
      },
    });
  }, [ready, depots.data]);

  // Marqueurs des téléphones, mis à jour sans recréer la carte.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready || !positions.data) return;

    const seen = new Set<string>();

    for (const position of positions.data) {
      seen.add(position.deviceId);
      const existing = markers.current.get(position.deviceId);

      if (existing) {
        existing.setLngLat([position.longitude, position.latitude]);
        const element = existing.getElement();
        element.style.background = markerColor(position);
        continue;
      }

      const element = document.createElement('button');
      element.style.cssText = `
        width: 14px; height: 14px; border-radius: 999px;
        border: 2px solid var(--color-surface); cursor: pointer;
        box-shadow: 0 1px 3px rgba(0,0,0,.35);
      `;
      element.style.background = markerColor(position);
      element.setAttribute('aria-label', position.assetTag);
      element.addEventListener('click', () => setSelected(position.deviceId));

      const marker = new maplibregl.Marker({ element })
        .setLngLat([position.longitude, position.latitude])
        .setPopup(
          new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(
            `<strong>${position.assetTag}</strong><br/>${
              position.user
                ? `${position.user.firstName} ${position.user.lastName}`
                : 'Aucune session'
            }`,
          ),
        )
        .addTo(instance);

      markers.current.set(position.deviceId, marker);
    }

    for (const [id, marker] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }

    if (positions.data.length > 0 && instance.getZoom() < 6) {
      const bounds = new maplibregl.LngLatBounds();
      positions.data.forEach((p) => bounds.extend([p.longitude, p.latitude]));
      instance.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 0 });
    }
  }, [ready, positions.data]);

  const list = useMemo(() => positions.data ?? [], [positions.data]);

  return (
    <>
      <PageHeader
        title="Carte de la flotte"
        description="Dernière position connue de chaque téléphone. Le suivi ne s’exécute que pendant une session active."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <div ref={container} style={{ height: '520px', width: '100%' }} />
          {!process.env.NEXT_PUBLIC_MAP_STYLE_URL && (
            <p
              className="px-5 py-2.5 text-xs"
              style={{
                color: 'var(--color-warn)',
                background: 'var(--color-warn-soft)',
              }}
            >
              Fond de carte de démonstration : contours de pays uniquement.
              Renseignez <code className="mono">NEXT_PUBLIC_MAP_STYLE_URL</code>{' '}
              pour un fond exploitable en production.
            </p>
          )}
        </Card>

        <Card title={`${list.length} téléphone(s) localisé(s)`}>
          {list.length === 0 ? (
            <EmptyState>
              Aucune position connue. Elle apparaîtra dès qu’un chauffeur ouvrira
              une session.
            </EmptyState>
          ) : (
            <ul className="max-h-[520px] overflow-y-auto">
              {list.map((position) => (
                <li
                  key={position.deviceId}
                  className="px-5 py-3"
                  style={{
                    borderTop: '1px solid var(--color-border)',
                    background:
                      selected === position.deviceId
                        ? 'var(--color-accent-soft)'
                        : undefined,
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/devices/${position.deviceId}`}
                      className="mono text-sm font-medium"
                      style={{ color: 'var(--color-accent)' }}
                    >
                      {position.assetTag}
                    </Link>
                    {position.isOffline ? (
                      <Badge tone="warn">Hors ligne</Badge>
                    ) : (
                      <Badge tone={deviceStateTone(position.state)}>
                        {position.sessionState === 'RETURNED'
                          ? 'Retourné'
                          : deviceStateLabel(position.state)}
                      </Badge>
                    )}
                  </div>
                  <div
                    className="mt-1 text-xs"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    {position.user ? fullName(position.user) : 'Aucune session'}
                    {position.depot && ` · ${position.depot.name}`}
                  </div>
                  <div
                    className="mono mt-0.5 text-xs"
                    style={{ color: 'var(--color-ink-faint)' }}
                  >
                    {formatAge(position.at)}
                    {position.accuracy != null &&
                      ` · ± ${Math.round(position.accuracy)} m`}
                    {position.batteryLevel != null && ` · ${position.batteryLevel}%`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
