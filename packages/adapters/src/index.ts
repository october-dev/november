/**
 * @november/adapters — hardware adapters and simulated devices.
 *
 * Adapters are the only code that touches transports (serial, GPIO, I2C,
 * SPI, MQTT). They run inside the privileged executor process (#8), never
 * in the agent process. Owner issues: #12 (serial), #13 (GPIO), #15 (I2C),
 * #16 (SPI), #18 (MQTT), #7 (simulators).
 */
export { listSimulatedDevices } from "./simulated.js";
export type { SimulatedDevice } from "./simulated.js";
export {
  HEARTBEAT_CUTOFF_MS,
  PICO_DEFAULT_ACTIVE_MS,
  PICO_MAX_ACTIVE_MS,
  createHostLed,
  createPicoLed,
} from "./watchdog.js";
export type { CommandResult, ProtectedLed } from "./watchdog.js";
export { createSimulatedAdapter } from "./simulated-adapter.js";
export type { SimulatedAdapter } from "./simulated-adapter.js";
