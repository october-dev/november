/**
 * @november/core — shared contracts for November.
 *
 * The versioned device configuration schema is added separately. This
 * package holds observations, actions, identity binding, and the adapter
 * lifecycle. It must stay free of hardware and model dependencies.
 * The action journal is #10. Policy enforcement is #8.
 */
export { ACTION_OUTCOMES, isUncertain } from "./outcomes.js";
export type { ActionOutcome } from "./outcomes.js";
export type { FieldError, ParseResult } from "./fields.js";
export {
  DEFAULT_FRESHNESS_MS,
  OBSERVATION_VALIDITY,
  assessObservation,
  parseObservation,
} from "./observation.js";
export type {
  Observation,
  ObservationSource,
  ObservationValidity,
} from "./observation.js";
export { parseDeviceAction } from "./action.js";
export type { DeviceAction } from "./action.js";
export {
  TRANSPORT_KINDS,
  bindResource,
  parseResourceIdentity,
} from "./identity.js";
export type {
  BindResult,
  ResourceIdentity,
  TransportKind,
} from "./identity.js";
export { checkAdapterContract } from "./adapter-contract.js";
export type { AdapterContractInput } from "./adapter-contract.js";
export type {
  AdapterHealth,
  AdapterOutcome,
  DeviceAdapter,
  DiscoveredResource,
  OpenResult,
} from "./adapter.js";
