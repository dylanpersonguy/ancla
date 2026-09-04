/**
 * Railway deployment for the static evidence site.
 *
 * There is no server and no volume here, which is the whole design: `pnpm export`
 * turns the 13 GB mirror into ~35 MB of files on a machine that holds the data,
 * and this serves those files from Caddy. Nothing deployed can reach the
 * archives, the index, or the anchor key.
 *
 * `dist/` is a build artifact and is gitignored, so a deploy is `pnpm export &&
 * railway up` from a machine with the mirror. That is deliberate rather than
 * awkward: what gets published is derived data, and the derivation should be
 * re-runnable by anyone from the publisher's own archives.
 */

import { defineRailway, project, service } from 'railway/iac';

export const partial = 'ancla';

export default defineRailway(() => {
  const site = service('ancla', {
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
    },
    deploy: {
      // Caddy answers on / with the change feed, so a failing container is
      // caught at deploy rather than after it has taken traffic.
      healthcheckPath: '/api',
      healthcheckTimeout: 30,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      // Static files, no session state. Sleeping would only add a cold start to
      // the first reader of the day.
      sleepApplication: false,
    },
  });

  return project('ancla', { resources: [site] });
});
