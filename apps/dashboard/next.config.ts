import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Sortie autonome : Next recopie dans `.next/standalone` le serveur et les
  // seules dependances qu'il utilise reellement. L'image de production pese
  // alors une centaine de mega-octets au lieu du dépôt entier, et surtout elle
  // n'embarque aucun outil de construction.
  output: 'standalone',
  // Le dashboard ne parle jamais directement a l'API : tout passe par ses
  // propres routes, qui detiennent les jetons en cookies httpOnly.
  // Voir src/app/api/proxy/[...path]/route.ts
  experimental: {
    typedRoutes: false,
  },
};

export default config;
