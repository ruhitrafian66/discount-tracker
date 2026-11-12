// The Pi's 15-minute staleness check, as a Netlify scheduled function. It only calls
// the external APIs when the weekly slot has passed or something is missing
// (see lib/app.js work()). Scheduled functions stop after 30 s, so a run stops
// starting new API calls after 18 s and the next run continues.
import core from '../../lib/app.js';
import { blobStore } from '../blob-store.mjs';

let app;

export default async () => {
  app ||= core.createApp({ store: blobStore(), env: process.env, globalTtlMs: 0 });
  await app.work({ budgetMs: 18e3 });
};

export const config = { schedule: '*/15 * * * *' };
