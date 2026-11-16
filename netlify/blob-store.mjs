// lib/store.js interface on Netlify Blobs. Strong consistency, so a write (an added
// item, a new session) is visible to the next request even on another instance.
import { getStore } from '@netlify/blobs';

export function blobStore(name = 'tilbud') {
  // Called per operation: the Blobs context is set up per invocation.
  const s = () => getStore({ name, consistency: 'strong' });
  return {
    async get(key) { return (await s().get(key, { type: 'json' })) ?? null; },
    // With the ETag of the copy in memory, an unchanged document is not sent again
    // (the offers document is over a megabyte).
    async getIfChanged(key, etag) {
      const r = await s().getWithMetadata(key, { type: 'json', etag });
      if (!r) return { value: null };
      if (etag && r.data === null) return { unchanged: true };
      return { value: r.data, etag: r.etag };
    },
    async set(key, value) { return { etag: (await s().setJSON(key, value)).etag }; },
    async del(key) { await s().delete(key); },
    async list(prefix) { return (await s().list({ prefix })).blobs.map((b) => b.key); },
  };
}
