import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 ist ein natives Modul und darf nicht gebundelt werden,
  // sonst bricht der App-Router-Build bzw. der Server-Start.
  serverExternalPackages: ['better-sqlite3'],

  experimental: {
    serverActions: {
      // Server Actions nehmen von Haus aus nur 1 MB entgegen. Die Importaktion
      // erlaubt aber Dateien bis 20 MB, und Next weist groessere Anfragen ab,
      // BEVOR die Action ueberhaupt laeuft - die freundliche Fehlermeldung dort
      // haette also nie gegriffen. 24 MB lassen zusaetzlich Luft fuer den
      // Mehraufwand von multipart/form-data (Grenzen, Teil-Kopfzeilen).
      bodySizeLimit: '24mb',
    },
  },
};

export default nextConfig;
