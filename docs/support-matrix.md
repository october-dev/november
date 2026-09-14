# v1 support matrix

This is the hardware boundary for [#2]. It defines the setup and evidence to qualify, not a claim that qualification has passed. [Release gates](release-gates.md) own workload and numeric limits; the [threat model](threat-model.md) owns trust boundaries. Implementation remains with the linked issues.

<a id="support-tiers"></a>

## Support tiers

The reference is a constrained baseline. The Qualified section stays empty until [#27] links passing evidence and its frozen manifest to an entry there; only that recorded configuration earns the label. Possible configurations carry no compatibility, performance, reliability, or safety claims. Owner: [#2]; qualification evidence: [#27].

<a id="reference-setup"></a>

### Reference (qualification pending)

| Component | Reference requirement | Implementation / evidence owner |
| --- | --- | --- |
| Linux host | Raspberry Pi 4 Model B, 4 GB RAM, arm64. | [#4], [#25], [#27] |
| OS | Raspberry Pi OS Lite 64-bit, Trixie-based; the exact image and kernel are frozen in the manifest. | [#4], [#25] |
| Networking | Ethernet; Wi-Fi and Bluetooth disabled in boot configuration, with actual radio state verified. | [#22], [#25] |
| Runtime | Node.js 24 LTS is proposed, subject to confirmation by #4 and #5; qualification records an exact `x.y.z`. | [#4], [#5] |
| MQTT broker | Mosquitto on the host, configured per #18: verified TLS, per-client credentials, topic ACLs, retained actuator commands rejected, and bounded queues. Exact version and configuration digest are frozen. | [#18] |
| Microcontroller | Raspberry Pi Pico non-W over USB CDC. Manual BOOTSEL flashing stays outside the harness; #17 pins the toolchain and provides firmware build/flash instructions. | [#12], [#17] |
| Inference | One hosted provider and one local model endpoint on a separate machine, both exercised with explicit provider selection. | [#5], [#27] |

<a id="qualified"></a>

### Qualified

<a id="possible"></a>

### Possible (untested, no claims)

| Configuration | Scope / evidence owner |
| --- | --- |
| Raspberry Pi 5 | [#2], [#27] |
| Raspberry Pi 3B+ | [#2], [#27] |
| Raspberry Pi Zero 2 W | [#2], [#27] |
| Jetson | [#2], [#27] |
| x86_64 Debian/Ubuntu host with a USB board | [#2], [#27] |
| Other RP2040 boards | [#12], [#17], [#27] |
| Arduino, ESP32, or STM32 boards speaking the #12 protocol | [#12], [#27] |
| Inference running on the Pi itself | [#5], [#27] |

<a id="peripherals-and-wiring"></a>

## Peripherals and wiring

All external fixture power and GPIO/bus signals are 3.3 V, with a common ground and no 5 V signal connections. GPIO numbers below use BCM numbering on the host; Pico GP25 is a board-local pin. USB connects the Pico to the host. The exact board/module revisions and wiring record belong to the manifest. Owner and wiring evidence: [#25].

| Device / role | Wiring and qualification boundary | Implementation / evidence owner |
| --- | --- | --- |
| Pico on-chip temperature, telemetry | Internal sensor, no external wiring. Reports chip temperature only; no ambient-temperature accuracy claim. | [#17], [#25] |
| Pico onboard LED, protected reference actuator | GP25, using the onboard LED circuit. Protective behavior is defined in [Safe states](#safe-states). | [#14], [#17], [#25] |
| Host LED, diagnostic output only | GPIO17 → 330 Ω series resistor → LED anode; LED cathode → ground. A 10 kΩ pull-down connects GPIO17 to ground. | [#13], [#25] |
| Host button, read-only input | GPIO27 to ground through the button; internal pull-up enabled, active-low. | [#13], [#25] |
| BME280, read-only telemetry | I2C1: SDA to GPIO2, SCL to GPIO3, 3.3 V supply and ground. Select address `0x76` with SDO grounded and I2C mode with CSB tied to VDDIO. Record the module's actual straps/pull-ups. | [#15], [#25] |
| SPI0 loopback, diagnostic fixture | Jumper MOSI GPIO10 (header pin 19) to MISO GPIO9 (pin 21). Freeze chip select, mode, speed, word size, transfer length, and jumper length before testing. Qualification covers only these settings and lengths; it grants no support to other SPI peripherals. | [#16], [#25] |

Pin and electrical references: [Raspberry Pi GPIO and SPI documentation](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#gpio); BME280 address and interface straps follow the [Bosch datasheet, sections 6–7](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf). These references support the wiring, not a November qualification claim.

<a id="safe-states"></a>

## Safe states

Numeric protective deadlines are defined only in the [release budgets](release-gates.md#provisional-engineering-thresholds), with their start points and observation rules in [Timing and measurement](release-gates.md#timing-and-measurement).

| Device or failure | Required observable behavior | Implementation / evidence owner |
| --- | --- | --- |
| Pico LED | Off on duration expiry, heartbeat loss, reset, and power-up; disarmed at boot. Clean shutdown requests off and stops heartbeats. USB disconnect or host loss invokes the firmware cutoff if the board remains powered; power loss de-energizes the LED, and power restoration starts off and disarmed. | [#14], [#17], [#25] |
| Host diagnostic LED | Maximum active time is **not applicable**: on or off is acceptable indefinitely because this resistor-limited 3.3 V LED has no hazard in either state. On clean shutdown, request low or input before releasing the line. Boot, crash, disconnect, and post-release states are platform-dependent and must be qualified by physical observation; the pull-down or closing a handle is not proof of the resulting state. Power loss de-energizes it. | [#13], [#14], [#25] |
| Read-only devices: chip sensor, button, BME280, loopback results | Mark data stale once its last valid observation is 10 s old; missing, reset, disconnected, or unpowered devices cannot provide a fresh reading. | [#13], [#15], [#16], [#17], [#19], [#25] |
| MQTT availability | Last Will and Testament (LWT) is availability metadata only, never proof of an output's physical state. | [#18], [#25] |
| Model or network loss | Start no new actions; already-running bounded actions finish within their existing protective deadlines. Fallback does not require another model call. | [#5], [#14], [#19] |
| Invalid policy or failed journal | The execution service disarms and stops the host heartbeat. Recovery requires a deliberate policy/state check and explicit arming; restart or reconnection never auto-arms. | [#8], [#10], [#14], [#22] |

The host diagnostic LED is a deliberate exception to [#14]'s per-output maximum-active-time requirement, valid only for outputs with no hazard in any state. Revisit this exception before changing its load or role. Evidence must cover both outputs; passing Pico tests alone does not establish #14 coverage. Owner: [#14]; physical evidence: [#13], [#25], [#27].

<a id="qualification-manifest"></a>

## Qualification manifest

[#27] freezes and publishes a sanitized manifest **before the run starts**, with links to the exact candidate and supporting evidence. Any blank field blocks release; placeholders and proposed versions are not frozen values. The table is a required-field specification, not a completed manifest. Values unavailable during this documentation task must be supplied by their owners before qualification. Material changes follow the [seven-day gate](release-gates.md#gate-checklist).

| Required field | Record before the run | Value / evidence owner |
| --- | --- | --- |
| Runtime | Confirmed Node.js `x.y.z`. | [#4], [#5] |
| OS image | Image URL and cryptographic digest. | [#4], [#25] |
| Kernel | Exact kernel version. | [#13], [#25] |
| Boot configuration | Complete sanitized configuration and digest, including configured and observed radio state and enabled buses. | [#22], [#25] |
| Dependency lockfile | Lockfile hash. | [#4] |
| Candidate artifacts | Candidate commit, artifact identities, and digests. | [#24], [#27] |
| Firmware | Source commit and flashed-image digest. | [#17] |
| Firmware toolchain | Pinned toolchain version, board selection, and reproducible build reference. | [#17] |
| Board revisions | Host, Pico, and BME280 module models/revisions; sanitized fixture labels, not private device identifiers. | [#25] |
| Wiring and buses | Exact wiring record; SPI chip select, mode, speed, word size, transfer length, and jumper length. | [#13], [#15], [#16], [#25] |
| Mosquitto | Exact version and configuration digest, with a sanitized configuration/effective-policy evidence link; no credentials. | [#18] |
| Model-call frequency | Scheduled frequency, bounded call/retry count, and provider exercise schedule matching the [workload envelope](release-gates.md#workload-envelope). | [#5], [#19] |
| Context and output limits | Numeric context and output token limits, turn/retry bounds, and model request timeout. | [#5] |
| Provider selection | Hosted provider/model selection and separate-machine local model/runtime identity; no private endpoint hostname or credential. | [#5] |
| Budget revision | Commit identifying the frozen [release budgets](release-gates.md#provisional-engineering-thresholds) and measurement rules. | [#2], [#27] |
| Fault schedule | Faults, triggers, timing, trial counts, independent observer/sampling setup, and uncertainty bound. | [#7], [#25], [#27] |

<a id="v1-exclusions"></a>

## v1 exclusions

| Exclusion | Scope owner |
| --- | --- |
| Safety-critical control and hard real-time control loops. | [#2], [#14] |
| Fleet dashboard. | [#2] |
| Arbitrary firmware flashing; reference flashing follows the manual boundary in [Reference setup](#reference-setup). | [#2], [#17] |
| Mandatory October account, October Bus, or other October service. | [#2], [#5] |
| Mains loads, motors, and pumps in the reference project. | [#2], [#25] |

[#2]: https://github.com/october-dev/november/issues/2
[#4]: https://github.com/october-dev/november/issues/4
[#5]: https://github.com/october-dev/november/issues/5
[#7]: https://github.com/october-dev/november/issues/7
[#8]: https://github.com/october-dev/november/issues/8
[#10]: https://github.com/october-dev/november/issues/10
[#12]: https://github.com/october-dev/november/issues/12
[#13]: https://github.com/october-dev/november/issues/13
[#14]: https://github.com/october-dev/november/issues/14
[#15]: https://github.com/october-dev/november/issues/15
[#16]: https://github.com/october-dev/november/issues/16
[#17]: https://github.com/october-dev/november/issues/17
[#18]: https://github.com/october-dev/november/issues/18
[#19]: https://github.com/october-dev/november/issues/19
[#22]: https://github.com/october-dev/november/issues/22
[#24]: https://github.com/october-dev/november/issues/24
[#25]: https://github.com/october-dev/november/issues/25
[#27]: https://github.com/october-dev/november/issues/27
