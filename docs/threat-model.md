# v1 threat model

This is the trust boundary for [#2], consumed by [#3] and [#26]. It describes required behavior for the [reference setup](support-matrix.md#reference-setup); it does not assert implemented defenses. The linked issues own implementation and evidence. [#26] must connect each required defense below to sanitized negative-test results in the [release gates](release-gates.md#gate-checklist).

<a id="trusted-base"></a>

## Trusted base

| Trusted component | Assumption / responsibility | Implementation / evidence owner |
| --- | --- | --- |
| Execution service | Enforces authorization and device/value/duration/rate/state checks outside the model. Physical access is possible only through this boundary for unprivileged clients. | [#8], [#26] |
| OS identities and device permissions | Separate execution and model identities; restrict device files, actuator credentials, and policy writes so model tools and ordinary clients cannot bypass the service through shell or direct access. | [#8], [#22], [#26] |
| Broker TLS and ACLs | Correctly configured and verified as specified in the [reference setup](support-matrix.md#reference-setup); credentials and topic authorization are part of the trusted base, not model authority. | [#18], [#26] |
| Firmware and wiring as installed | The selected firmware and physical fixture enforce the [device safe states](support-matrix.md#safe-states). This assumption ends when either is changed; valid protocol messages alone do not establish it. | [#14], [#17], [#25], [#26] |

<a id="untrusted-inputs"></a>

## Untrusted inputs

| Input / attacker capability | Required boundary and negative-test evidence | Implementation / evidence owner |
| --- | --- | --- |
| Model output | Every proposed action is untrusted, including otherwise well-formed tool calls. The model cannot authorize itself, edit policy, or expand an approval's device, payload, or policy version. Test forged calls and policy bypass. | [#5], [#8], [#26] |
| Injection through sensor text, serial logs, and MQTT payloads | Treat content as data, never instructions or permissions. Test payloads that request shell access, credential disclosure, policy changes, cross-device actions, or repeated execution. | [#5], [#8], [#12], [#18], [#26] |
| Device messages | Validate framing, size, identity, correlation, and freshness. Valid framing is not physical truth: a device can lie about a reading or action. Preserve the [outcome semantics](release-gates.md#outcome-semantics) when execution evidence is insufficient. | [#10], [#12], [#15], [#16], [#18], [#26] |
| Local clients, including localhost connections | Localhost is not authentication. Authenticate callers and enforce device/operation scope and exact, expiring approvals; test unauthorized local clients, direct-device/shell bypass, and cross-device requests. | [#8], [#22], [#26] |
| Duplicate, stale, malformed, or flooding requests | Clients and transports can resend, reorder, delay, or flood work. Test stale owners and conflicting callers against [admission limits](release-gates.md#storage-and-admission), [outcome rules](release-gates.md#outcome-semantics), and stop/status availability. | [#10], [#11], [#12], [#18], [#19], [#26] |

<a id="administrator-and-physical-bypass"></a>

## Administrator and physical bypass

| Bypass capability | What v1 does not defend | Boundary / evidence owner |
| --- | --- | --- |
| Host administrator with root or equivalent authority | Can replace the execution service, change identities/permissions/policy, read credentials, alter broker configuration, write devices directly, or falsify host records. The execution boundary does not constrain host root. | [#8], [#22], [#26] |
| Physical attacker | Can rewire outputs, replace devices, reflash firmware, or cut power. These can bypass installed protective behavior or destroy evidence; firmware safe-state guarantees are void once reflashed. | [#14], [#17], [#25], [#26] |
| Compromised kernel, OS image, or supply chain | Can undermine the trusted base before checks run. This model assumes an uncompromised base; provenance and dependency review provide evidence about artifacts, not containment of an already-compromised base. | [#4], [#24], [#26] |

<a id="out-of-scope"></a>

## Out of scope

The [v1 exclusions](support-matrix.md#v1-exclusions) are authoritative for excluded uses and features. This threat model adds no safety-critical or availability guarantee against the bypass capabilities above. Owner: [#2]; boundary review: [#26].

Output behavior during model/network loss, invalid policy, and journal failure is defined in [Safe states](support-matrix.md#safe-states), including the deliberate host diagnostic LED exception and its evidence limits. Owners: [#14], [#25], [#26].

[#2]: https://github.com/october-dev/november/issues/2
[#3]: https://github.com/october-dev/november/issues/3
[#4]: https://github.com/october-dev/november/issues/4
[#5]: https://github.com/october-dev/november/issues/5
[#8]: https://github.com/october-dev/november/issues/8
[#10]: https://github.com/october-dev/november/issues/10
[#11]: https://github.com/october-dev/november/issues/11
[#12]: https://github.com/october-dev/november/issues/12
[#14]: https://github.com/october-dev/november/issues/14
[#15]: https://github.com/october-dev/november/issues/15
[#16]: https://github.com/october-dev/november/issues/16
[#17]: https://github.com/october-dev/november/issues/17
[#18]: https://github.com/october-dev/november/issues/18
[#19]: https://github.com/october-dev/november/issues/19
[#22]: https://github.com/october-dev/november/issues/22
[#24]: https://github.com/october-dev/november/issues/24
[#25]: https://github.com/october-dev/november/issues/25
[#26]: https://github.com/october-dev/november/issues/26
