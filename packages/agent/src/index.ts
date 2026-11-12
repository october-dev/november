/**
 * @november/agent — model loop for one project and device.
 *
 * The loop is Pi's agent core, behind the adapter in this package. Hardware
 * is not imported here. A model request can only ask the injected execution
 * client to act, and that client lives in the execution service.
 */
export { AGENT_LIMITS, estimateTokens } from "./limits.js";
export type { AgentLimits } from "./limits.js";
export { boundContext } from "./context.js";
export { AGENT_LOOP_LIBRARY } from "./providers.js";
export type { FakeStep, ProviderSelection, TokenField } from "./providers.js";
export { SessionError } from "./session.js";
export type {
  ExecutionReply,
  HardwareRequest,
  StoredMessage,
} from "./session.js";
export {
  HARDWARE_TOOL_NAME,
  SYSTEM_PROMPT,
  createDeviceAgent,
  createRejectingExecutionClient,
  DeviceAgent,
} from "./loop.js";
export type {
  AgentPermissions,
  DeviceAgentOptions,
  ExecutionClient,
  RunResult,
} from "./loop.js";
