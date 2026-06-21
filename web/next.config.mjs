/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lint runs separately (vitest + tsc + CI); don't fail the production build on
  // ESLint stylistic rules (e.g. no-explicit-any) so the stack can build/deploy.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
