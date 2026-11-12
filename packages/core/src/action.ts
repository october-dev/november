/**
 * One requested device action.
 *
 * `deadlineMs` is a duration from admission, not a wall-clock instant, so a
 * clock change cannot extend it. `expectedState` is the state the command
 * claims it will leave behind. Parsing an action does not execute it.
 */
import {
  checkName,
  isRecord,
  unknownFieldErrors,
  type FieldError,
  type ParseResult,
} from "./fields.js";

const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export interface DeviceAction {
  readonly commandId: string;
  readonly deviceId: string;
  readonly operation: string;
  readonly payload: boolean | number | string | null;
  readonly deadlineMs: number;
  readonly expectedState: boolean | number | string | null;
}

export function parseDeviceAction(input: unknown): ParseResult<DeviceAction> {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  const errors: FieldError[] = unknownFieldErrors(
    input,
    [
      "commandId",
      "deviceId",
      "operation",
      "payload",
      "deadlineMs",
      "expectedState",
    ],
    "",
  );
  if (
    typeof input.commandId !== "string" ||
    !COMMAND_PATTERN.test(input.commandId)
  ) {
    errors.push({
      path: "commandId",
      message:
        "must be lowercase letters, digits or dashes, starting with a letter",
    });
  }
  const deviceId = checkName(input.deviceId, "deviceId");
  const operation = checkName(input.operation, "operation");
  if (deviceId) errors.push(deviceId);
  if (operation) errors.push(operation);
  if (!isPayload(input.payload)) {
    errors.push({
      path: "payload",
      message:
        "must be a boolean, a finite number, a string of at most 1024 characters, or null",
    });
  }
  if (!isPayload(input.expectedState)) {
    errors.push({
      path: "expectedState",
      message:
        "must be a boolean, a finite number, a string of at most 1024 characters, or null",
    });
  }
  if (
    typeof input.deadlineMs !== "number" ||
    !Number.isInteger(input.deadlineMs) ||
    input.deadlineMs < 1 ||
    input.deadlineMs > 86_400_000
  ) {
    errors.push({
      path: "deadlineMs",
      message: "must be an integer number of milliseconds from 1 to 86400000",
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      commandId: input.commandId as string,
      deviceId: input.deviceId as string,
      operation: input.operation as string,
      payload: input.payload as DeviceAction["payload"],
      deadlineMs: input.deadlineMs as number,
      expectedState: input.expectedState as DeviceAction["expectedState"],
    },
  };
}

function isPayload(value: unknown): value is DeviceAction["payload"] {
  if (typeof value === "boolean" || value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.length <= 1024;
}
