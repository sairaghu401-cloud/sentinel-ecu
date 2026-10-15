# Verified simulator milestone

The software simulation, local server, dashboard, trace replay and validation workflow are implemented. No hardware is required to run this milestone.

## Verification completed

- Public deployment verified on October 15, 2026 at `https://sentinel-ecu.pages.dev/`: browser worker startup, step/run/pause, maximum battery flood, 12/12 live validation cases, CSV trace import, CSV and JSON downloads, reset, and no observed browser errors. HTTPS assets and content security policy verified. GitHub CI passes on Windows/Linux with Node 22/24.
- The visual redesign applies locally vendored Tabler components and Amber Minimal tokens, Barlow typography, an original selectable vehicle schematic, and motion tied to run/pause/connectivity. Sources and interaction semantics are in `DESIGN.md`.
- Vehicle signal selection and normal/reduced-motion behavior pass browser checks. Additional 320, 768 and 1024px checks cover all four views. The analyst switch now preserves its requested position while awaiting the server response.

- 57 automated tests pass across the engine, parser, evaluator, HTTP integration and browser session adapter, including model parity, tab isolation, import/export, the maximum battery flood and delayed Pi telemetry.
- The Cloudflare browser edition shares the simulation engine with Node and runs each tab in an isolated worker; validation runs in a separate worker. Browser sessions are in-memory and trace files stay on the device. See `DEPLOYMENT.md`.
- October 15 increment: soft white/orange theme and clearer text; 17 browser checks pass. The detection panel separates gateway filtering, real Pi payload observations and independent safety criteria. Battery flooding no longer appears under an ambiguous `Normal operation` label. The existing detection and shutdown policy is preserved.
- All 12 default seeded synthetic acceptance cases pass. This means their declared behavioral checks pass, not that detection is perfect.
- The earlier evaluator milestone was exercised over four seeds and three accepted durations (144 case executions). After intensity calibration, the current default 12-case suite and minimum-duration regression pass; the earlier matrix is historical evidence.
- The browser workflow passes run/pause/step/speed, attack/filter/degrade, analyst loss, explicit recovery, frame inspection, downloads, invalid import rollback, valid import, reset, validation and actual server restart/reconnect.
- Desktop 1440×900 and narrow 390×844 layouts were rendered and inspected. All four narrow tabs avoid page-level horizontal overflow; the network diagram and wide data tables scroll inside their own panels. Keyboard tabs, focus and reduced motion were checked.
- Browser logs contain no unexpected runtime/console errors in the checked workflow.
- The frontend design evidence checker accepts `artifacts/browser/evidence.json`. Screenshots were also visually reviewed; the checker alone does not establish visual quality.

Run results are retained in `artifacts/validation-report.json` and `artifacts/browser/`. The optional browser verification script is `scripts/browser-check.mjs`. It needs a development installation of Playwright and Chrome; the simulator does not. An absolute Playwright entry file can be provided through `PLAYWRIGHT_MODULE` when using a bundled runtime.

## Findings to preserve

Both synthetic clean profiles pass without false positives. Attacks can still cause collateral blocking of legitimate frames sharing the compromised identifier. Flooding can exhaust modeled ingress capacity, and those drops are counted as availability losses rather than successful detections. Default flooding recall is approximately 58% across all offered attack frames even though inspected attack recall is 100%. Stealth detection deliberately has early misses while the statistical evidence accumulates. These results are visible in the validation table and exported report.

The next research increment should tune collateral blocking and evaluate external, labelled traces using vehicle-specific schemas and unchanged held-out test sets. That work is separate from the completed synthetic simulator. Real automotive deployment would additionally require firmware, hardware-in-the-loop tests, threat/safety analysis and timing measurements.

## Operating boundary

Run on localhost with Node.js 22 or newer. The server starts paused and saves recent session reports locally. No external deployment, physical CAN connection, secure element, relay, or motor control is included. Hardware timing, embedded memory footprint, RTOS latency and real cross-dataset accuracy remain unmeasured. Production automotive readiness is not claimed.

## Intensity calibration increment

Five levels now change actual generated traffic for every family. Payload corruption previously ignored intensity; it now affects 10/25/50/75/100 percent of target frames. The preview, active attack and history expose the submitted strength. See INTENSITY.md and artifacts/intensity-comparison.json for the 30-case fixed battery comparison. Detector and safety thresholds remain evidence-driven.

