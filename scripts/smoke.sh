#!/usr/bin/env bash
# Smoke-test built artifacts (issue #4). Requires `pnpm build` first.
# Runs the published entry points without hardware, network, or model access.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== smoke: cli --version"
node packages/cli/dist/index.js --version

echo "== smoke: cli doctor"
node packages/cli/dist/index.js doctor

echo "== smoke: package entry points load"
node -e '
Promise.all([
  import("./packages/core/dist/index.js"),
  import("./packages/adapters/dist/index.js"),
  import("./packages/executor/dist/index.js"),
  import("./packages/service/dist/index.js"),
]).then(([core, adapters, executor, service]) => {
  if (!Array.isArray(core.ACTION_OUTCOMES)) throw new Error("core export missing");
  if (adapters.listSimulatedDevices().length === 0) throw new Error("no simulated devices");
  if (executor.executorStatus().armed !== false) throw new Error("executor must start disarmed");
  if (service.serviceHealth().name !== "november") throw new Error("service export missing");
});
'

echo "smoke: OK"
