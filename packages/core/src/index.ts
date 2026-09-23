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
