import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 ist ein natives Modul und darf nicht gebundelt werden,
  // sonst bricht der App-Router-Build bzw. der Server-Start.
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
