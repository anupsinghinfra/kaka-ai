import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // OnCell/Anthropic calls happen exclusively in server route handlers;
  // nothing here is exposed to the browser.
  reactStrictMode: true,
  // Pin file tracing to the monorepo root (a stray lockfile in $HOME
  // otherwise makes Next guess the wrong workspace root).
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url))
}

export default nextConfig
