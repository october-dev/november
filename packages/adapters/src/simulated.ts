/**
 * Simulated devices for tests and development without hardware.
 *
 * Issue #7 expands this into the full simulator and failure test rig;
 * issue #6 defines the adapter contract these will implement. For now the
 * registry only names the simulated counterparts of the reference setup
 * (docs/support-matrix.md).
 */
export interface SimulatedDevice {
  readonly id: string;
  readonly kind: "led" | "button" | "pico" | "bme280" | "spi-loopback";
  readonly description: string;
}

const SIMULATED_DEVICES: readonly SimulatedDevice[] = [
  {
    id: "sim-host-led",
    kind: "led",
    description: "Host diagnostic LED (GPIO17 role from the reference setup)",
  },
  {
    id: "sim-host-button",
    kind: "button",
    description: "Host read-only button (GPIO27 role from the reference setup)",
  },
  {
    id: "sim-pico",
    kind: "pico",
    description:
      "Pico over serial with the protected LED actuator and heartbeat cutoff",
  },
  {
    id: "sim-bme280",
    kind: "bme280",
    description: "BME280 telemetry sensor on I2C",
  },
  {
    id: "sim-spi-loopback",
    kind: "spi-loopback",
    description: "SPI0 MOSI-to-MISO loopback fixture",
  },
];

export function listSimulatedDevices(): readonly SimulatedDevice[] {
  return SIMULATED_DEVICES;
}
