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
