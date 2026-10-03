import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */

// Baseline response security headers. A full Content-Security-Policy is not
// set yet on purpose: wallet extensions, RPC endpoints, LI.FI and Supabase
// all need explicit allowances and a wrong policy silently breaks signing.
// `frame-ancestors 'none'` (with X-Frame-Options for old browsers) stops the
// app — which asks users to sign transactions — from being framed for
// clickjacking.
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig = {
  // Pin the workspace root to this project. Without it, a stray lockfile in a
  // parent folder (e.g. the user's home directory) makes Next pick that folder
  // as the root — wrong file tracing and a much larger tree to watch in dev.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // `viem/chains` is a barrel of ~600 chain definitions. Without this, every
  // route that imports one chain makes dev mode compile all of them (and the
  // `ox/tempo` "Critical dependency" warning comes from one of those).
  experimental: {
    optimizePackageImports: ['viem/chains'],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
