```text
 _   _  ___  __     __ _____  __  __  ____   _____  ____
| \ | |/ _ \ \ \   / /| ____||  \/  || __ ) | ____||  _ \
|  \| | | | | \ \ / / |  _|  | |\/| ||  _ \ |  _|  | |_) |
| |\  | |_| |  \ V /  | |___ | |  | || |_) || |___ |  _ <
|_| \_|\___/    \_/   |_____||_|  |_||____/ |_____||_| \_\
```

# November

**Build the device. Ship the harness.**

November is October's hardware agent harness, being designed as an open-source foundation for connected devices. It is for engineers building those devices and for the devices themselves: one shared core that works at the bench and runs in the field.

An agent harness connects a model to tools, state, and execution. November's tools interact with the physical world: serial ports, sensors, GPIO pins, I2C/SPI peripherals, and MQTT-connected devices.

> **Status: design stage.** This repository currently contains the product and architecture proposal. The capabilities below are planned, not implemented. There is no installable release or production safety guarantee yet.

## The idea

An engineer connects a sensor, reads its output, and tests an actuator. Later, the shipped device reads that same sensor and controls that same actuator. The hardware operations are the same; the permissions and operating conditions are not.

November should make that transition a deployment step, not a rewrite onto a different platform.

The ambition is to become a default open-source foundation for hardware and IoT companies: useful for a single board on a desk, designed to grow into a product a manufacturer can ship and maintain.

## One core, two ways to run it

```text
       ENGINEERING BENCH                  DEPLOYED DEVICE
   interactive development              unattended service
   inspect, simulate, debug              bounded operation
                |                               |
                +---------------+---------------+
                                |
                     NOVEMBER SHARED CORE
                 agent loop + device state
                 model routing + event history
                                |
                      proposed operations
                                v
                  POLICY + EXECUTION SERVICE
                  authorize, limit, reconcile
                                |
                +---------------+---------------+
                |               |               |
             Serial          GPIO / I2C         MQTT
             targets            / SPI          devices

       Independent watchdogs and device interlocks remain
       responsible for time-critical protective behavior.
```

**At the bench:** discover devices, inspect readings, develop behavior, simulate actions, and diagnose failures. October Harness can be a development interface, but November must also work independently.

**In the field:** run the same device definitions, hardware adapters, and policy machinery as a supervised service. Development-only tools and permissions do not ship by default. Each deployment has a versioned configuration and explicit operating limits.

One core does not mean identical privileges, an always-running model, or a terminal UI installed on every appliance.

## Hardware first

The first runtime target is a Linux-class host: Raspberry Pi, Jetson, or a similar appliance computer. Exact supported boards and operating systems will be established through testing.

Arduino-class boards, ESP32, and STM32 are initially connected targets. November runs on a host and communicates with their firmware; the full agent runtime is not expected to run on the microcontroller.

Planned interfaces:

| Interface | What it enables |
| --- | --- |
| Serial / USB | Communicate with boards, collect logs, and exchange structured commands. |
| GPIO | Read digital inputs and request bounded output changes. |
| I2C / SPI | Read sensors and interact with supported peripherals. |
| MQTT | Observe device telemetry and issue authorized commands. |
| Simulation | Exercise device behavior without energizing real hardware. |

Every controllable resource needs an explicit identity, operation schema, and deployment policy. A pin number or MQTT topic alone is not permission to actuate it.

## Physical actions are different

If a file read fails, retrying is usually harmless. If a pump command succeeds but its acknowledgement is lost, retrying could dispense twice.

November must record what was requested, what was authorized, and what is known to have happened. An unknown outcome is not a failed action and must not be blindly replayed.

These requirements shape the core from the beginning:

- **Authorization outside the model.** A separate execution service validates operations against device-specific limits. The agent must not bypass it through shell access, raw device files, or unrestricted broker credentials.
- **Bounded actuation.** Policies define allowed resources, value ranges, rates, durations, and operating conditions. Prompt instructions are not enforcement.
- **Explicit command outcomes.** Durable command identifiers, duplicate handling, deadlines, and state reconciliation address retries and restarts. If hardware cannot confirm an outcome, that uncertainty remains visible.
- **Independent protective controls.** Firmware or hardware handles hard deadlines, interlocks, and emergency stops. Restarting an agent is not a substitute for an actuator watchdog.
- **Defined behavior without a model.** Network loss, unavailable inference, and exhausted budgets must have a device-specific response. Local inference is an option; predictable fallback behavior is mandatory.
- **Inspectable operation.** Correlate observations, proposals, policy decisions, execution results, and faults. Bound local storage and redact credentials and sensitive data.
- **Controlled deployment.** Version device configuration and policies, test upgrades and recovery, and support rollback. Agent-generated skills must not silently change production permissions.

This is not a claim of functional-safety certification or suitability for safety-critical use. Product-specific hazard analysis and validation remain necessary before deployment.

## Reuse the machinery. Own the hardware behavior.

November will be a separate product and repository, not a copy of the October Harness application.

The proposed starting point is an existing agent-loop library, with Pi's agent core as the initial candidate. Hardware integrations can use reviewed libraries or Model Context Protocol (MCP) servers where appropriate. An integration protocol does not establish a safety boundary; actuation still passes through November's enforcement layer.

The work that belongs here is the shared hardware core: device definitions, adapters, action policies, execution records, recovery behavior, observability, and the development and runtime entry points.

### Where it fits in October

| Project | Role |
| --- | --- |
| [October Harness](https://github.com/october-dev/october-harness) | Coding and interactive development; an optional interface for building with November. |
| **November** | Hardware-native development and deployed operation over one shared core. |
| [October Bus](https://github.com/october-dev/october-bus) | Optional coordination between agents and services; not the device controller or the actuation authority. |

November must be able to run without October Desktop, October Bus, or an October cloud account. Model providers and any future hosted services should be replaceable, optional integrations.

## First milestone: one device, end to end

Start with one Linux board, a USB-connected microcontroller, a low-risk sensor/actuator pair, and MQTT. Demonstrate the same device behavior during development and after deployment.

1. Define the device's observations, permitted operations, and operating limits.
2. Inspect readings and test actions interactively, including a simulated run.
3. Deploy that configuration as a supervised, headless service.
4. Disconnect the network, duplicate a command, lose an acknowledgement, and restart the process.
5. Show the resulting device state and a trace explaining every allowed, rejected, completed, or uncertain action.

Success means the deployed device stays within its defined operating policy, does not blindly repeat actions, and remains diagnosable when inference or connectivity is unavailable. It does not mean claiming support for every board or building a fleet dashboard first.

## Scope and contribution

Near-term work is the shared core and that first end-to-end reference device. A broad board catalog, fleet management, hosted services, and richer integrations come after the execution and recovery model is proven.

Useful early contributions include concrete device workflows, adapter proposals, failure scenarios, and review of the policy and execution boundary. Include the board, transport, intended action, and what must happen when it fails.

**License:** an open-source license will be selected and added before implementation contributions are accepted. Public visibility alone is not a license grant.
