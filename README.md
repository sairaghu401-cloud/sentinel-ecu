# Sentinel ECU

A complete local software laboratory for the Sentinel ECU capstone: a two-segment CAN security gateway, an independent learned anomaly detector, a separate safety task, controlled attacks, and a live evidence dashboard. No hardware or online service is required.

## Start

Install **Node.js 22 or newer**, then double-click **Start Sentinel.cmd** on Windows. Open **http://127.0.0.1:8787** after the ready message appears. Keep the terminal open while using the laboratory. Press Ctrl+C to save the session and stop.

From any terminal in this folder:

```sh
npm start
```

There are no packages to install. The application uses Node's standard library and native browser APIs. Tabler CSS, the Amber Minimal theme and Barlow fonts are included locally; no runtime CDN, analytics, font service, API key or hardware driver is needed. The server binds to your computer's loopback address. If port 8787 is occupied, set the `PORT` environment variable before starting. Design sources and licenses are documented in [docs/DESIGN.md](docs/DESIGN.md).

## A five minute demonstration

1. Open **Overview**, keep the Urban profile and seed 42, and run the simulation. The vehicle schematic shows protected signal values. Expand **Network architecture** to follow CAN A through the gateway to CAN B and the receiving ECU.
2. Observe normal forwarding, rule checks, the traffic plot, and the live vehicle values. Pause and step forward to inspect individual frames.
3. Select a vehicle signal on the schematic (or use the attack target selector), then inject **Payload manipulation** or **Flooding** against a critical signal. Observe blocked frames and their explanations. The accumulated evidence raises the response level. A separate safety task acknowledges a degradation request.
4. Disconnect the analyst using the Pi control. Repeat a rule-detectable attack: the gateway still filters traffic and healthy traffic continues to flow.
5. Clear attacks, run through the quiet interval, and request recovery when eligible. The safety state does not silently clear itself.
6. Open **Traffic inspector** to filter and inspect decisions. Export the session as JSON for full provenance or CSV for the retained frame window.
7. Open **Validation** and run the repeatable suite. Compare the gateway against an ID-whitelist baseline on the same labelled synthetic frames.

Use Reset to start a new session with a chosen seed/profile. Pausing freezes simulated time. Speed changes simulation progress per timer callback; operating-system scheduling can make the observed wall-clock rate differ.

## What is implemented

- Separate modeled CAN A and CAN B paths with finite queues, CAN ID priority, a 500 kbit/s serialization budget, and modeled forwarding latency.
- Gateway checks for allowed IDs, DLC, timing, rate, payload plausibility, and counter/payload replay evidence.
- A statistical anomaly model trained on a separate synthetic normal sample, with asynchronous evidence from the simulated Pi. The Pi is outside the forwarding path.
- Criticality-weighted risk, sequential evidence accumulation, and OBSERVE → WARN → FILTER → REQUEST_DEGRADE responses.
- An independent safety task with delayed acknowledgment, a latched degraded state, and explicit recovery after a quiet interval.
- Spoofing, replay, flooding, fuzzing, out-of-range payload manipulation, and in-range statistical anomalies.
- Seeded Urban and Highway profiles, labelled evaluation, honest precision/recall/false-positive metrics, and baseline comparison.
- CSV/candump import, bounded evidence buffers, JSON/CSV exports, automatic local session snapshots, and streaming dashboard updates.
- Strict input validation, same-origin checks, bounded request and connection sizes, error handling, automated tests, and CI configuration.

## Validate

```sh
npm test
npm run validate
npm run check
```

The validation command writes an experiment report under `artifacts/`. It exits unsuccessfully if a required experiment check fails. Tests cover detector behavior, reproducibility, parsing, safety recovery, API boundaries, streaming, import/export, and session storage. CI runs the tests and synthetic validation on Windows and Linux using Node 22 and 24.

## Import traces

Use Traffic inspector's import control. Examples are in [examples](examples/). Supported input is classical standard CAN with 11-bit IDs and at most eight data bytes; CAN FD, extended IDs, RTR and error frames are outside this version's scope.

Canonical CSV:

```csv
timestamp_ms,id,data,label
0,0x120,00 00 00 00 00 00 00 01,normal
10,0x777,FF FF,attack
```

The example above illustrates syntax, not the built-in signal payload layout. Use the supplied fixture for an actual scenario. IDs with `0x` are hexadecimal; unprefixed CSV IDs are decimal. Candump IDs are hexadecimal. Timestamps must be nondecreasing and are normalized to the first frame. Labels are optional and used only to score results; unlabelled frames are excluded from the confusion matrix. See [trace schema](docs/TRACE_FORMAT.md).

Import evaluates a fresh isolated session against the built-in vehicle schema. It never changes gateway rules to fit the uploaded trace. Real vehicle traces need a corresponding ID, payload, cadence, and training configuration before their scores are meaningful. Imported sessions remain paused and cannot be mixed with synthetic traffic; reset to resume generation.

## Saved evidence

The server saves JSON reports in `data/` every ten seconds, on reset/import, and on graceful shutdown, keeping the latest 30 session files. They include configuration, cumulative counters, bounded recent frames/events, provenance and model descriptions. The history endpoint is `GET /api/sessions`; session files can be opened directly. Automatic resume is intentionally absent: opening the app starts a fresh paused session.

Frame/event history is bounded so long demonstrations do not grow memory indefinitely. Cumulative counts may therefore exceed exported frame counts. JSON exports describe retention and distinguish measured host processing times from simulated bus/safety times. Do not infer full-run accuracy from a truncated exported frame window.

## Scope of the results

This is an engineered **software-in-the-loop simulation**, not certified vehicle firmware. The implemented checks and safety behavior are exercised in software. Synthetic validation and two simulated driving profiles do not establish real-world attack coverage or cross-dataset generalization. No STM32 CPU/RAM/flash footprint, RTOS scheduling, GPIO waveform, physical CAN timing, relay operation, or electrical fault tolerance has been measured.

CAN payloads and criticality values are an explicit demonstration schema, not an OEM DBC. Counter checks provide replay evidence, not cryptographic authentication. The separate safety task models a requested operating mode and a motor indicator; it does not control a real actuator. The ATECC608 enhancement remains optional future hardware work.

Read [architecture and assumptions](docs/ARCHITECTURE.md), [validation methodology](docs/VALIDATION.md), and [API reference](docs/API.md) before using results in a report.

The completed checks, observed limitations, and next research increment are recorded in [verified milestone status](docs/STATUS.md).

## Project structure

| Path | Purpose |
|---|---|
| `src/simulation.js` | Deterministic traffic, buses, gateway, analyst, risk and safety model |
| `src/datasets.js` | Strict trace parsing and safe CSV export |
| `src/experiments.js` | Reproducible synthetic scenarios and baseline scoring |
| `src/server.js` | Local HTTP API, live stream, exports and persistence |
| `web/` | Dashboard, traffic inspector, validation and guide |
| `tests/` | Automated engine, parser, experiment and API tests |
| `examples/` | Importable trace fixtures |
| `artifacts/` | Experiment results and browser verification evidence |
| `docs/` | Architecture, assumptions, schema, API and verification |

The supplied project PDF and Claude context were used as design references. The current request supersedes their hardware-dependent demonstration: every hardware role is represented by a software component, and no hardware result is claimed.
## Browser deployment

Build an independently usable public site with `npm run build`. Cloudflare Pages serves `dist/`; each visitor runs the actual simulator in an isolated browser worker. Traces stay in the browser, and exports retain model evidence. Reloading starts a new session. See [deployment instructions](docs/DEPLOYMENT.md).

