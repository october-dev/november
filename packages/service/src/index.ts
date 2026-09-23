/**
 * @november/service — supervised Linux service entry point.
 *
 * Runs the executor under systemd on the device (#22) with the same core
 * the development CLI uses, minus development permissions. Scaffold only:
 * supervision, health reporting, and lifecycle belong to #22 and #23.
 */
import { executorStatus } from "@november/executor";

export const SERVICE_NAME = "november";

/** Service-level view of executor readiness for health checks (#23). */
export function serviceHealth(): {
  name: string;
  ready: boolean;
  armed: boolean;
} {
  const status = executorStatus();
  return { name: SERVICE_NAME, ready: status.ready, armed: status.armed };
}
