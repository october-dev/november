# v1 release gates

This is the release contract for [#2], not a report of passing tests. Qualify the [reference setup](support-matrix.md#reference-setup) against its [safe states](support-matrix.md#safe-states) and the [threat model](threat-model.md). Each owning issue supplies the sanitized evidence named below; implementation design remains with those issues.

<a id="workload-envelope"></a>

## Workload envelope

| Work | Declared qualification load | Implementation / evidence owner |
| --- | --- | --- |
| Sensors | Read each of the two telemetry sensors every 10 s; a BME280 reading can contain multiple measurements in one message. | [#17], [#15], [#19], [#27] |
| Model | One scheduled model turn every 5 min, with bounded context and output. Freeze numeric token, request-time, call/retry limits, and provider selection in the [manifest](support-matrix.md#qualification-manifest). | [#5], [#19], [#27] |
| Telemetry | 0.2 msg/s aggregate across the two sensors; payload at most 1 KiB per message. Bursts reach at most 10 msg/s for at most 10 s, at most hourly. | [#18], [#19], [#27] |
| Local inference resources | Report local-model machine, runtime, memory, CPU, disk/model storage, and request latency separately. These resources are outside the Pi harness budgets; the Pi's client/agent overhead remains inside them. | [#5], [#27] |

<a id="provisional-engineering-thresholds"></a>

## Provisional engineering thresholds

These are pre-declared engineering thresholds, not measured results. They are release limits for the frozen workload and manifest. [#27] must report failures and limitations; an unsuitable budget requires a declared revision and a new qualifying run, not a retroactive pass. Byte units are binary (`KiB = 1024 B`, `MiB = 1024 KiB`). Scope owner: [#2]; measurement evidence: [#27].

| Area | Limit and accounting boundary | Implementation / evidence owner |
| --- | --- | --- |
| Memory | Execution service ≤150 MiB p99; agent process ≤400 MiB p99; growth slope ≤5 MiB/day for each. Use cgroup `memory.current` per systemd unit, including its children. | [#22], [#27] |
| CPU | Execution service and agent combined: idle ≤5% of one core averaged over 5 min; workload ≤50% of one core averaged over 1 min. 100% means one fully occupied core, not the whole Pi. | [#22], [#27] |
| Disk | Install ≤500 MiB for November and required runtime/dependencies, excluding the OS; diagnostic logs ≤512 MiB with rotation; action journal ≤512 MiB total, including unresolved records and overhead. | [#24], [#23], [#10], [#27] |
| Low space | Under 200 MiB free on the journal filesystem reports degraded; under 100 MiB free or any failed journal write blocks new physical dispatch. | [#10], [#22], [#23] |
| Queues | Pending actions: 100 entries / 1 MiB. Observations: 1000 entries / 4 MiB. Outbound telemetry: 8,640 messages / 16 MiB (about 12 h at the normal envelope rate; bursts shorten this). Both count and byte caps apply independently. | [#11], [#18], [#19] |
| Startup | With healthy dependencies, service ready within 10 s of service start; otherwise expose degraded, disarmed status within that bound. Reconciliation reaches a decided status within 5 s of starting reconciliation. Never auto-arm; use the [safe-state recovery rule](support-matrix.md#safe-states). Healthy power-on to ready ≤90 s. | [#10], [#14], [#22] |
| Serial / protected output | Serial acknowledgement ≤500 ms from dispatch. Pico LED active duration ≤30 s, firmware-enforced and immutable per command; default 2 s. Duplicates and heartbeats cannot extend that duration. Host heartbeat loss cuts the output within 2 s. | [#12], [#14], [#17] |
| Reads / publish | Sensor operation ≤1 s; I2C transfer ≤250 ms; SPI transfer ≤100 ms; MQTT publish accepted within 5 s. Start at admission of the relevant operation, including its queue wait. The sensor bound includes its underlying transfer. | [#12], [#15], [#16], [#18] |
| Recovery | A single healthy restart is ready within 15 s of process exit; repeated-failure restart backoff caps at 60 s. Replug identity/state verification completes within 10 s of physical reattachment. Firmware reaches its safe state after host loss within the heartbeat cutoff above. | [#12], [#14], [#17], [#22] |

<a id="storage-and-admission"></a>

## Storage and admission

| Condition | Required behavior | Implementation / evidence owner |
| --- | --- | --- |
| Journal reclamation | Remove only entries past the replay and deduplication expiry defined by #10. If safe reclamation cannot make room, reject physical dispatch. Never reclaim entries still protected by #10's retention rules merely to satisfy the disk budget. | [#10] |
| Queue saturation | Reject and count admissions exceeding either cap; keep stop and status available at saturation. Apply the same bounded-admission rule to telemetry rather than treating its queue as unlimited. | [#11], [#18], [#19], [#23] |
| Offline operation | Never buffer actuator commands offline or replay them after reconnection/restart. Telemetry buffering grants no authority to queue physical work. | [#10], [#12], [#18], [#19] |
| Broker delivery | Broker-side drops are outside harness promises. Publish acceptance or broker acknowledgement is not proof of physical execution; command outcomes require application evidence under [Outcome semantics](#outcome-semantics). | [#18], [#10] |

<a id="timing-and-measurement"></a>

## Timing and measurement

| Measurement | Required interpretation / evidence | Implementation / evidence owner |
| --- | --- | --- |
| Bounds | Stated deadline numbers are hard upper bounds. Firmware leaves its own margin. State measurement uncertainty separately at ≤10 ms; it is not permitted lateness and must not be added to a deadline. A result whose uncertainty could conceal a violation cannot establish a pass. | [#14], [#17], [#27] |
| Protective start points | Maximum active time counts from physical output activation. Host-loss cutoff counts from the last valid heartbeat, including when the host stalls without disconnecting. Use monotonic deadlines; reboot or wall-clock changes cannot extend an action. | [#14], [#17] |
| Protective observation | Every trial must satisfy the protective deadlines. Use an independent observer of the physical output and heartbeat with a sampling interval of 10 ms or finer; host logs alone are insufficient. Publish traces, trial counts, and the uncertainty bound. | [#14], [#17], [#25], [#27] |
| Resource sampling | Sample every 10 s; report sampled maximum and p99, with samples and memory growth in MiB/day per unit. Compute growth from elapsed-time memory samples with a declared fit, reporting restart segments so resets cannot hide growth. Sampled maximum/p99 characterize resource trends only and cannot establish protective timing. | [#22], [#23], [#27] |
| Resource windows | Derive CPU use from CPU-time deltas over the declared averaging windows. Report workload, idle, restart, and fault intervals, missing samples, and local-model resources separately; resource p99 does not waive per-trial protective bounds. | [#22], [#27] |
| Readiness and reconciliation | Ready means policy validated, dependencies checked, and reconciliation finished, with status and stop responsive; it does not mean armed. A decided reconciliation status can be a confirmed outcome or explicitly unknown, never fabricated success. Missing dependencies produce the degraded state specified in the budget. | [#10], [#14], [#22] |
| Completion evidence | A read returns valid data or an explicit failure/timeout by its deadline. Serial acknowledgement means protocol acknowledgement; MQTT acceptance means acceptance by the bounded publisher. Neither establishes physical completion. | [#10], [#12], [#15], [#16], [#18] |

<a id="outcome-semantics"></a>

## Outcome semantics

Reuse [#10]'s outcome names: `rejected`, `queued`, `dispatched`, `confirmed`, `failed`, `cancelled-before-dispatch`, and `unknown`. #10 owns transitions, persistence, replay/deduplication expiry, and reconciliation; this contract does not define a second state machine.

| Observation | Required outcome rule | Implementation / evidence owner |
| --- | --- | --- |
| Expiry before dispatch | `cancelled-before-dispatch`; no physical dispatch occurs. | [#10] |
| Dispatch without sufficient execution evidence, including a lost reply or crash | `unknown`; an unknown actuator outcome never auto-retries. Reconcile under #10. | [#10], [#12], [#17], [#18] |
| Cancellation, timeout, or transport acknowledgement after dispatch | Report only what evidence supports. None proves the physical action was undone or completed. | [#10], [#18] |
| Reused command ID or a duplicate delivery | Follow #10's identity/payload checks and deduplication rules; never count transport delivery as another authorized physical action. | [#10], [#17], [#18] |

<a id="gate-checklist"></a>

## Gate checklist

Every gate is required for the exact candidate. An unchecked gate or missing evidence blocks release. Evidence links must identify the manifest/candidate, method, expected limits, observed results, and owning issue. Publish synthetic or sanitized data only: no personal data, private hostnames, device identifiers, credentials, or private notes. Evidence sanitation owners: [#3], [#23], [#26], [#29].

| Gate | Required result and sanitized evidence artifact | Owning issue |
| --- | --- | --- |
| [ ] Fresh and offline install | Clean reference-host installation outside the source tree, plus installation from the documented offline bundle. Artifact: installation transcripts, candidate digests, and simulation/sensor/action/service smoke results. | [#24] |
| [ ] Simulator suite | Deterministic sensor/action and fault tests pass with real hardware access disabled. Artifact: suite report, seeds, and fault fixtures. | [#7] |
| [ ] Real hardware | Exercise serial/firmware, GPIO, I2C, SPI loopback, and MQTT. Cover crashes at every action-state transition, including windows around persistence, dispatch, and acknowledgement; lost replies; reset; disconnect/replug; a replaced board on the same port; saturation with stop/status available; retained and duplicate MQTT commands. Verify that a replacement never silently inherits authority. Artifact: fixture/wiring record, board execution counters correlated with command IDs/outcomes, and independent physical-output traces for both outputs verifying their [safe-state rules](support-matrix.md#safe-states), including measured protective deadlines where applicable. | [#13], [#14], [#15], [#16], [#17], [#25]; protocol/outcome checks: [#10], [#12], [#18] |
| [ ] Security and failure suite | All defenses within the [threat-model scope](threat-model.md) have passing negative-test evidence; no unresolved blocking safety/security defects. Artifact: sanitized suite report, defect dispositions, and maintainer security review. | [#26] |
| [ ] Seven-day continuous run | At least seven continuous days tied to the [frozen manifest](support-matrix.md#qualification-manifest), using the declared workload and scheduled network/broker outages, board disconnect/reset, process crashes, host restart, lost replies, and interrupted updates. Require zero unauthorized or unintended repeated physical actions, all protective deadlines met, every uncertain outcome recorded, and resource/recovery limits met. Planned faults remain part of elapsed run time. Artifact: manifest, raw sanitized measurements, fault timeline, action/outcome and execution-counter audit, and limitations. Fix failures and rerun affected tests; material candidate, runtime, firmware, configuration, workload, or budget changes restart the full run. | [#27] |
| [ ] Interrupted update and rollback | Test interrupted update, failed migration where applicable, health checks, and rollback to the known-good candidate while preserving action uncertainty and preventing replay. Artifact: before/after artifact identities, interruption/recovery transcripts, and action-state evidence. | [#24] |
| [ ] Maintainer release review | Link every v1 task's merged implementation and passing evidence for the candidate; no open release-blocking safety, security, installation, or recovery defect. Review sanitized release contents and the supported configuration. Artifact: candidate-specific approval and evidence index. | [#29] |

Passing is not safety certification, proof of months-long reliability, or support for [untested hardware](support-matrix.md#possible). The README's design-stage notice remains until #29's release checks pass. Owners: [#27], [#29].

[#2]: https://github.com/october-dev/november/issues/2
[#3]: https://github.com/october-dev/november/issues/3
[#5]: https://github.com/october-dev/november/issues/5
[#7]: https://github.com/october-dev/november/issues/7
[#10]: https://github.com/october-dev/november/issues/10
[#11]: https://github.com/october-dev/november/issues/11
[#12]: https://github.com/october-dev/november/issues/12
[#13]: https://github.com/october-dev/november/issues/13
[#14]: https://github.com/october-dev/november/issues/14
[#15]: https://github.com/october-dev/november/issues/15
[#16]: https://github.com/october-dev/november/issues/16
[#17]: https://github.com/october-dev/november/issues/17
[#18]: https://github.com/october-dev/november/issues/18
[#19]: https://github.com/october-dev/november/issues/19
[#22]: https://github.com/october-dev/november/issues/22
[#23]: https://github.com/october-dev/november/issues/23
[#24]: https://github.com/october-dev/november/issues/24
[#25]: https://github.com/october-dev/november/issues/25
[#26]: https://github.com/october-dev/november/issues/26
[#27]: https://github.com/october-dev/november/issues/27
[#29]: https://github.com/october-dev/november/issues/29
