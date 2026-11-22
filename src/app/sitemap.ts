import type { MetadataRoute } from 'next';
export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://flarehq.xyz';
  // `/streams` is deliberately NOT advertised: the Streams surface is removed
  // from navigation (sidebar + sitemap). The page, its APIs and the deployed
  // ArcFlareStream contract stay in place — this is a navigation change only.
  return ['', '/marketplace', '/agents', '/flarehq-jobs', '/terms', '/privacy'].map((path) => ({ url: `${base}${path}`, lastModified: new Date('2026-11-22'), changeFrequency: path === '/terms' || path === '/privacy' ? 'monthly' as const : 'weekly' as const, priority: path === '' ? 1 : path === '/terms' || path === '/privacy' ? 0.3 : 0.7 }));
}
