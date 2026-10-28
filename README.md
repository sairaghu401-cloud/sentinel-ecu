# Sentinel ECU

[**Open the live simulator**](https://sentinel-ecu.pages.dev/) · [Validation checks](https://github.com/sairaghu401-cloud/sentinel-ecu/actions)

A complete local software laboratory for the Sentinel ECU capstone: a two-segment CAN security gateway, an independent learned anomaly detector, a separate safety task, controlled attacks, and a live evidence dashboard. No hardware or online service is required.

The hosted browser edition works without installing anything or keeping a server running. Each tab has an independent simulation. Imported traces stay on your device; export your results before reloading or closing. Cloudflare Pages automatically deploys `main`. GitHub Actions runs the simulation and browser checks, then verifies that the live assets match that exact commit. Cloudflare deployment runs independently of CI; CI verifies the release rather than blocking it.

## Start

The approved Signal Resolve introduction is at `/`, and the interactive workbench is at `/simulator/`. The architecture walkthrough runs an isolated model preview. The introduction loads without starting a simulation. The classic laboratory remains at `/laboratory/`; legacy traffic/validation/guide bookmarks route there.

Install **Node.js 22 or newer**, then double-click **Start Sentinel.cmd** on Windows. Open **http://127.0.0.1:8787** after the ready message appears. Keep the terminal open while using the laboratory. Press Ctrl+C to save the session and stop.

### Presentation and public pages

`npm run build` prepares the browser edition, generates model-aligned explanation pages, and preserves the simulator at `/simulator/`. `npm run preview` opens a local preview server at **http://127.0.0.1:8788**. Public pages cover `/how-it-works/`, `/attack-scenarios/` and `/validation/`, with canonical metadata, a sitemap and a locally rendered social image.

The presentation uses locally bundled Archivo and IBM Plex Mono fonts, SVG, a dithered canvas vehicle and native browser animation. It introduces no production dependency or external requests. See [the approved R2 contract](docs/SIGNAL-RESOLVE-CONTRACT.md). `npm run test:browser` covers the classic laboratory and the approved presentation, including desktop/mobile, reduced motion, real packet journeys, imports/exports, safety recovery and validation. Browser evidence is written under `artifacts/browser/`.

From any terminal in this folder:

```sh
npm start
```

There are no packages to install. The application uses Node's standard library and native browser APIs. Archivo and IBM Plex Mono are included locally for Signal Resolve; the classic laboratory retains Tabler, Amber Minimal and Barlow. No runtime CDN, analytics, font service, API key or hardware driver is needed. The server binds to your computer's loopback address. If port 8787 is occupied, set the `PORT` environment variable before starting. Design sources and licenses are documented in [docs/DESIGN.md](docs/DESIGN.md).

## A five minute demonstration

1. Select **Open simulator**, keep Urban and seed 42, then press **Run**. The message journey shows frames offered to CAN A, filtered at the gateway, and delivered on CAN B.
2. Choose **ECU spoofing**, **0x130 Steering**, and **Low**. Inject and confirm. Normal frames continue while rejected frames stop at the gateway; safety need not degrade.
3. Open **Evidence**. Select a blocked frame to pin its recorded path, exact rule reason and downstream result. Select a forwarded frame to see delivery to the ECU. Selection does not pause the model.
4. Try **CAN flooding / Maximum** to distinguish queue drops from rule blocks. Counter accounting includes queued traffic.
5. For a safety experiment, use **Payload manipulation / 0x120 Brake / Maximum**. The model alone determines whether evidence triggers degradation. Stop attacks, continue through the quiet interval, and explicitly request recovery when eligible.
6. Use the Pi switch to disconnect the analyst; gateway rules remain active.
7. Open **Tools** for JSON/CSV export, CSV/candump import and the isolated 12-case validation suite. Import replaces the current run with a completed replay; export evidence first. Reset starts a new synthetic session.
8. On phones, use **Monitor**, **Attack**, **Evidence**, and **Sim** along the bottom. Reduced motion retains static paths, verdicts and receipt labels.

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

The validation command writes an experiment report under `artifacts/`. It exits unsuccessfully if a required experiment check fails. Tests cover detector behavior, reproducibility, parsing, safety recovery, API boundaries, streaming, import/export, and session storage. CI runs the tests and synthetic validation on Windows and Linux using Node 22 and 24, and runs the browser checks (`npm run test:browser`) in Chromium.

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

Build an independently usable public site with `npm run build`. Cloudflare Pages serves `dist/`; each visitor runs the actual simulator in an isolated browser worker. Traces stay in the browser, and exports retain model evidence. Reloading starts a new session.

Cloudflare Pages automatically publishes `main`. After the simulation and browser jobs pass, GitHub Actions waits until the live site reports that commit in `/_release.json` and checks the public assets. This is deployment verification, not a pre-deployment gate: Cloudflare can publish while CI is still running. Use a tested pull request before merging changes to `main`. See [deployment instructions](docs/DEPLOYMENT.md).

