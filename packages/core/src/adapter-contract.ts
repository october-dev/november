/**
 * Checks every adapter must pass. The checks are the contract: they do not
 * know whether the adapter is simulated or backed by a device file. They fail
 * if discovery or a refused open changes `actuationCount`.
 */
import type { DeviceAdapter } from "./adapter.js";
import type { DeviceAction } from "./action.js";
import type { ResourceIdentity } from "./identity.js";

export interface AdapterContractInput {
  readonly adapter: DeviceAdapter;
  readonly configured: ResourceIdentity;
  /** Same key as `configured`, different path. Replug must bind this. */
  readonly replugged: ResourceIdentity;
  /** Same path as `configured` may be used, but the key must differ. */
  readonly replaced: ResourceIdentity;
  readonly deviceId: string;
  readonly readOperation: string;
  readonly actuate: DeviceAction;
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
  if (
    !Number.isInteger(reading.timestampMs) ||
    !Number.isInteger(reading.freshnessMs)
  ) {
    fail("read omitted timestamp or freshness");
  }
  if (!["valid", "stale", "invalid", "missing"].includes(reading.validity)) {
    fail("read omitted validity");
  }
  if (input.actuationCount() !== beforeReject) fail("read actuated the device");

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

  const executed = await input.adapter.execute(input.actuate, input.nowMs);
  if (executed.commandId !== input.actuate.commandId)
    fail("execute did not echo the command id");
  if (
    executed.outcome !== "confirmed" &&
    executed.outcome !== "rejected" &&
    executed.outcome !== "unknown"
  ) {
    fail(`execute returned an unexpected outcome ${executed.outcome}`);
  }
  const afterExecute = input.actuationCount();
  if (executed.outcome === "confirmed" && afterExecute <= beforeReject) {
    fail("confirmed execute did not record an actuation");
  }
  if (executed.outcome !== "confirmed" && afterExecute !== beforeReject) {
    fail("a non-confirmed execute changed the actuation count");
  }

  const again = await input.adapter.reconcile(input.actuate.commandId);
  if (again.outcome !== executed.outcome) {
    fail("reconcile changed the outcome of a known command");
  }
  if (input.actuationCount() !== afterExecute)
    fail("reconcile actuated the device");

  const missing = await input.adapter.reconcile("missing-command");
  if (missing.outcome !== "unknown")
    fail(`unknown command reconciled as ${missing.outcome}`);
  if (input.actuationCount() !== afterExecute)
    fail("reconcile of an unknown command actuated the device");

  const repeated = await input.adapter.execute(input.actuate, input.nowMs);
  if (repeated.outcome !== executed.outcome)
    fail("repeating a command id changed its outcome");
  if (input.actuationCount() !== afterExecute)
    fail("repeating a command id actuated again");

  await input.adapter.close();
  const health = input.adapter.health();
  if (health.state !== "closed") fail(`health after close was ${health.state}`);
  const afterClose = await input.adapter.execute(input.actuate, input.nowMs);
  if (afterClose.outcome === "confirmed")
    fail("execute after close was confirmed");
  if (input.actuationCount() !== afterExecute)
    fail("execute after close actuated the device");
  const discoveredAgain = await input.adapter.discover();
  if (discoveredAgain.length === 0)
    fail("discover after close returned nothing");
  if (input.actuationCount() !== afterExecute)
    fail("discover after close actuated the device");

  return failures;
}
