// lib/store.js interface on Netlify Blobs. Strong consistency, so a write (an added
// item, a new session) is visible to the next request even on another instance.
import { getStore } from '@netlify/blobs';

export function blobStore(name = 'tilbud') {
  // Called per operation: the Blobs context is set up per invocation.
  const s = () => getStore({ name, consistency: 'strong' });
  return {
    async get(key) { return (await s().get(key, { type: 'json' })) ?? null; },
    async set(key, value) { await s().setJSON(key, value); },
    async del(key) { await s().delete(key); },
    async list(prefix) { return (await s().list({ prefix })).blobs.map((b) => b.key); },
  };
}
