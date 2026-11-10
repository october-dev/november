/**
 * @november/core — shared contracts for November.
 *
 * Device configuration and adapter contracts are defined by issue #6;
 * the action journal by #10; policy enforcement by #8. This package holds
 * only the vocabulary shared across the agent side and the privileged
 * executor side, and must stay free of hardware and model dependencies.
 */
export { ACTION_OUTCOMES, isUncertain } from "./outcomes.js";
export type { ActionOutcome } from "./outcomes.js";
export {
  DEVICE_CONFIG_SCHEMA_VERSION,
  parseDeviceConfig,
} from "./device-config.js";
export type {
  ConfigError,
  DeviceConfig,
  DeviceSpec,
  GpioTransport,
  I2cTransport,
  Operation,
  OperationValue,
  ParseResult,
  SafeState,
  SpiTransport,
  Transport,
} from "./device-config.js";
