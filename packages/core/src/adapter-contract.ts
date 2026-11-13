/**
 * Checks every adapter must pass. The checks are the contract: they do not
 * know whether the adapter is simulated or backed by a device file. They fail
 * if discovery or a refused open changes `actuationCount`.
 */
import type { DeviceAdapter } from "./adapter.js";
import type { DeviceAction } from "./action.js";
import type { ResourceIdentity } from "./identity.js";
import { parseObservation } from "./observation.js";

export interface AdapterContractInput {
  readonly adapter: DeviceAdapter;
  readonly configured: ResourceIdentity;
  /** Same key as `configured`, different path. Replug must bind this. */
  readonly replugged: ResourceIdentity;
  /** Same path as `configured` may be used, but the key must differ. */
  readonly replaced: ResourceIdentity;
  readonly deviceId: string;
  readonly readOperation: string;
  /** A device id the open adapter must refuse to serve. */
  readonly foreignDeviceId: string;
  readonly actuate: DeviceAction;
  /** Same device and operation as `actuate`, with a fresh command id. */
  readonly actuateFresh: DeviceAction;
  readonly unsupported: DeviceAction;
  readonly nowMs: number;
  readonly actuationCount: () => number;
}

export async function checkAdapterContract(
  input: AdapterContractInput,
): Promise<readonly string[]> {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);
  const beforeDiscover = input.actuationCount();
  const discovered = await input.adapter.discover();
  if (input.actuationCount() !== beforeDiscover) {
    fail("discover actuated the device");
  }
  if (discovered.length === 0) fail("discover returned no resources");
  if (
    !discovered.some(
      (resource) => resource.identity.key === input.configured.key,
    )
  ) {
    fail("discover did not return the configured identity key");
  }

  const beforeReject = input.actuationCount();
  const rejected = await input.adapter.open(input.replaced);
  if (rejected.ok) fail("open accepted a different identity key");
  if (input.actuationCount() !== beforeReject)
    fail("rejected open actuated the device");

  const opened = await input.adapter.open(input.replugged);
  if (!opened.ok)
    fail(
      `open rejected a replugged device with the same key: ${opened.ok ? "" : opened.reason}`,
    );
  if (input.actuationCount() !== beforeReject) fail("open actuated the device");

  const reading = await input.adapter.read(
    input.deviceId,
    input.readOperation,
    input.nowMs,
  );
  if (
    reading.source.deviceId !== input.deviceId ||
    reading.source.operation !== input.readOperation
  ) {
    fail("read returned a different source");
  }
  const parsed = parseObservation(reading);
  if (!parsed.ok) {
    fail(
      `read returned an observation the parser rejects: ${parsed.errors
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")}`,
    );
  }
  if (input.actuationCount() !== beforeReject) fail("read actuated the device");

  const foreignRead = await input.adapter.read(
    input.foreignDeviceId,
    input.readOperation,
    input.nowMs,
  );
  if (foreignRead.validity === "valid") {
    fail("read reported foreign data as valid");
  }
  if (input.actuationCount() !== beforeReject)
    fail("foreign read actuated the device");

  const unsupported = await input.adapter.execute(
    input.unsupported,
    input.nowMs,
  );
  if (unsupported.outcome !== "rejected") {
    fail(`unsupported operation returned ${unsupported.outcome}, not rejected`);
  }
  if (unsupported.commandId !== input.unsupported.commandId) {
    fail("unsupported operation did not echo the command id");
  }
  if (input.actuationCount() !== beforeReject)
    fail("unsupported operation actuated the device");

  const foreignExecute = await input.adapter.execute(
    {
      ...input.actuate,
      deviceId: input.foreignDeviceId,
      commandId: "cmd-foreign-device",
    },
    input.nowMs,
  );
  if (foreignExecute.outcome !== "rejected") {
    fail("execute admitted a foreign device");
  }
  if (input.actuationCount() !== beforeReject)
    fail("foreign execute actuated the device");

  const executed = await input.adapter.execute(input.actuate, input.nowMs);
  if (executed.commandId !== input.actuate.commandId)
    fail("execute did not echo the command id");
  if (
    executed.outcome !== "confirmed" &&
    executed.outcome !== "rejected" &&
    executed.outcome !== "failed" &&
    executed.outcome !== "unknown"
  ) {
    fail(`execute returned an unexpected outcome ${executed.outcome}`);
  }
  const afterExecute = input.actuationCount();
  if (executed.outcome === "confirmed" && afterExecute <= beforeReject) {
    fail("confirmed execute did not record an actuation");
  }
  if (executed.outcome === "rejected" && afterExecute !== beforeReject) {
    fail("a rejected execute changed the actuation count");
  }
  if (executed.outcome === "failed" && afterExecute !== beforeReject) {
    fail("an evidenced failure changed the actuation count");
  }

  const again = await input.adapter.reconcile(input.actuate.commandId);
  if (again.commandId !== input.actuate.commandId)
    fail("reconcile did not echo the command id");
  let latest = again.outcome;
  if (executed.outcome === "unknown") {
    if (latest !== "unknown" && latest !== "confirmed" && latest !== "failed") {
      fail(`reconcile of an uncertain command returned ${latest}`);
    }
  } else if (latest !== executed.outcome) {
    fail("reconcile changed a decided outcome");
  }
  if (input.actuationCount() !== afterExecute)
    fail("reconcile actuated the device");

  // Evidence may arrive after the reconcile above: a duplicate may move an
  // uncertain command to confirmed or failed. A decided outcome stays put.
  const acceptsLatestOutcome = (next: typeof latest): boolean => {
    if (latest === "unknown" && (next === "confirmed" || next === "failed")) {
      latest = next;
    }
    return next === latest;
  };

  const missing = await input.adapter.reconcile("missing-command");
  if (missing.outcome !== "unknown")
    fail(`unknown command reconciled as ${missing.outcome}`);
  if (missing.commandId !== "missing-command")
    fail("reconcile did not echo the unknown command id");
  if (input.actuationCount() !== afterExecute)
    fail("reconcile of an unknown command actuated the device");

  const repeated = await input.adapter.execute(input.actuate, input.nowMs);
  if (repeated.commandId !== input.actuate.commandId)
    fail("repeated command did not echo the command id");
  if (!acceptsLatestOutcome(repeated.outcome))
    fail(
      "repeating a command id disagrees with the latest established outcome",
    );
  if (input.actuationCount() !== afterExecute)
    fail("repeating a command id actuated again");

  await input.adapter.close();
  const health = input.adapter.health();
  if (health.state !== "closed") fail(`health after close was ${health.state}`);
  const completed = await input.adapter.execute(input.actuate, input.nowMs);
  if (completed.commandId !== input.actuate.commandId)
    fail("completed command after close did not echo the command id");
  if (!acceptsLatestOutcome(completed.outcome))
    fail("close changed a completed command's outcome");
  if (input.actuationCount() !== afterExecute)
    fail("completed command after close actuated the device");
  const fresh = await input.adapter.execute(input.actuateFresh, input.nowMs);
  if (fresh.outcome !== "rejected")
    fail("execute after close accepted new work");
  if (fresh.commandId !== input.actuateFresh.commandId)
    fail("fresh command after close did not echo the command id");
  if (input.actuationCount() !== afterExecute)
    fail("fresh command after close actuated the device");
  const discoveredAgain = await input.adapter.discover();
  if (discoveredAgain.length === 0)
    fail("discover after close returned nothing");
  if (input.actuationCount() !== afterExecute)
    fail("discover after close actuated the device");

  return failures;
}
