import type { MetadataRoute } from 'next';
export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://flarehq.xyz';
  return ['', '/marketplace', '/agents', '/flarehq-jobs', '/streams', '/terms', '/privacy'].map((path) => ({ url: `${base}${path}`, lastModified: new Date('2026-11-20'), changeFrequency: path === '/terms' || path === '/privacy' ? 'monthly' as const : 'weekly' as const, priority: path === '' ? 1 : path === '/terms' || path === '/privacy' ? 0.3 : 0.7 }));
}
