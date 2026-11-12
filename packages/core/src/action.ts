/**
 * One requested device action.
 *
 * `commandId` names this request: lowercase letters, digits, or dashes,
 * starting with a letter, 1-63 characters. The journal (#10) owns
 * deduplication and retention for command ids; adapters must not
 * re-apply an id they already recorded.
 *
 * `deadlineMs` is a duration from admission, not a wall-clock instant, so a
 * clock change cannot extend it. `expectedState` is the state the command
 * claims it will leave behind. Parsing an action does not execute it.
 *
 * Payloads are intentionally scalar-or-null here, while configured
 * operations may also describe byte transfers: byte results enter the
 * system as observations, and an adapter-specific encoding carries them
 * on the wire.
 */
import { z } from "zod";
import {
  Id,
  integer,
  parseWith,
  says,
  type ContractParseResult,
} from "./fields.js";

const PAYLOAD_MESSAGE =
  "must be a boolean, a finite number, a string of at most 1024 characters, or null";

const Payload = z.union(
  [
    z.boolean(),
    z.number().refine(Number.isFinite),
    z.string().max(1024),
    z.null(),
  ],
  says(PAYLOAD_MESSAGE),
);

const DeviceActionSchema = z.strictObject({
  commandId: Id,
  deviceId: Id,
  operation: Id,
  payload: Payload,
  deadlineMs: integer(
    1,
    86_400_000,
    "must be an integer number of milliseconds from 1 to 86400000",
  ),
  expectedState: Payload,
});

export type DeviceAction = z.output<typeof DeviceActionSchema>;

export function parseDeviceAction(
  input: unknown,
): ContractParseResult<DeviceAction> {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  return parseWith(DeviceActionSchema, input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
