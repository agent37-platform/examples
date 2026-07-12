import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This example is self-contained; pin tracing to its own folder so a sibling lockfile in the
  // monorepo root doesn't get picked as the workspace root.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
