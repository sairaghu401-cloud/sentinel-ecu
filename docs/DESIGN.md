# Sentinel workbench design

The October 2026 redesign replaces the initial navy sidebar dashboard with a vehicle security workbench. After user feedback about eye strain, the October 15 revision uses soft white and light gray surfaces, restrained burnt-orange actions, a silver vehicle schematic, and Segoe UI body/readout text. The main visual remains an original top-view vehicle SVG.

## Applied sources

| Source | Use | License / local copy |
| --- | --- | --- |
| [Tabler on GitHub](https://github.com/tabler/tabler), @tabler/core 1.6.1 | Actual locally served component CSS; card, button and table classes, customized for the workbench | MIT; `licenses/tabler.txt` |
| [tweakcn Amber Minimal preset](https://tweakcn.com/r/themes/amber-minimal.json), [repository](https://github.com/jnsahaj/tweakcn) | Original light tokens retained in `web/vendor/theme.css`; the current workbench adapts these to soft white, gray and burnt orange | Apache-2.0; `licenses/tweakcn.txt` |
| [Barlow / Barlow Condensed](https://github.com/google/fonts/tree/main/ofl/barlow) | Locally served regular, semibold and condensed semibold fonts | SIL Open Font License; `licenses/barlow.txt`, `licenses/barlow-condensed.txt` |
| [MotionSites.ai](https://motionsites.ai/) | Public security/engineering gallery as art-direction reference: technical diagrams, strong typography, restrained motion | Reference only; no paid prompts, source code or proprietary imagery copied |
| [Motion animation documentation](https://motion.dev/docs/animate) | Reference for short, purposeful transitions | Reference only; implementation uses native Web Animations and CSS, not the Motion package |

The Sentinel monogram and vehicle drawing are original local vectors. No third-party JavaScript, remote runtime font service, account or build step is needed. The server's explicit static allowlist exposes only necessary assets. Vendor hashes are recorded in `vendor-manifest.json`.

## Interaction contract

- Keep real simulation counts and limits. No fabricated traffic or animated counters.
- Select Brake (0x120), Steering (0x130), Powertrain (0x200) or Battery (0x300) on the vehicle to set the actual attack selector. Selecting Body or Infotainment in the selector clears the schematic selection.
- Readouts show the protected vehicle's current state. Safety intervention changes the gateway color and status text. Labels remain explicit about simulation.
- Detection & safety separates STM32 gateway protection, Raspberry Pi payload analysis and independent vehicle safety. The Pi displays actual processed payload/outlier counts and unexpired holds; it does not infer detection from the injected attack label. Vehicle safety displays `Shutdown not requested` and explains missing request criteria when gateway evidence exists. A battery flood can raise risk to 100 while its payloads remain statistically normal and critical-signal evidence is absent. Detection and shutdown policy are unchanged by this display revision.
- Moving CAN dashes indicate that the model is running; they do not represent individual frames or measured bandwidth. They stop when paused or disconnected. Reduced-motion preference disables packet movement and entry transitions.
- Tab entry uses a 300ms opacity/8px transform transition. Buttons use 160ms interactions. No extra animation runtime is loaded.
- Expand Network architecture to inspect the ESP32, STM32, Pi, safety task and protected ECU boundary.
- All controls remain keyboard accessible. Responsive targets are 1440×900 and 390×844; additional overflow checks cover 320, 768 and 1024px. On narrow screens experiment controls precede traffic history. Wide evidence tables and the expanded architecture diagram scroll inside their own panels.

## Verification and maintenance

Run `scripts/browser-check.mjs` with Playwright and Chrome available. It drives the real local engine, including all four views, offline recovery, signal selection, normal/reduced motion and the analyst toggle. Screenshots and the evidence record are in `artifacts/browser/`. Review screenshots as well as assertions; this is not a complete accessibility audit.

`styles.css` retains shared functional layout rules; `workbench.css` supplies the new theme, typography, vehicle schematic and responsive composition after it. Tabler and theme tokens load first. Before-redesign files are retained under `artifacts/redesign-before/` for comparison.
