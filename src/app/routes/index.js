/** App route table (Phase 2): registration order is matching priority. */
import { createAdminRoutes } from './admin.js';
import { createHealthRoutes } from './health.js';
import { createV1Route } from './v1/index.js';

export function createAppRoutes({ config, webDir, serviceName }) {
  return [
    ...createHealthRoutes(),
    ...createAdminRoutes({ config, webDir, serviceName }),
    createV1Route({ config })
  ];
}

export default { createAppRoutes };
