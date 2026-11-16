// All /api/* routes on Netlify. Same core as the Pi (lib/app.js), stored in Netlify Blobs.
import core from '../../lib/app.js';
import { blobStore } from '../blob-store.mjs';

let app;  // reused while the function instance stays warm

export default async (req, context) => {
  // Shared data (offers, settings) is checked against the store after a minute: the
  // scheduled refresh runs in another instance. For up to ten minutes a request is
  // answered from memory while that check runs.
  app ||= core.createApp({ store: blobStore(), env: process.env, globalTtlMs: 60e3, globalMaxStaleMs: 10 * 60e3 });
  return app.handle(req, { background: (p) => (context.waitUntil ? context.waitUntil(p) : p) });
};

export const config = { path: '/api/*' };
