# Sentinel workbench design

The current surface implements the user-approved Signal Resolve R2 export (28 October 2026): `web/signal.html` and `web/design/`. The dark introduction resolves into a warm-white vehicle-security workbench. Archivo and IBM Plex Mono are bundled under `web/design/fonts/` with their SIL Open Font License texts. The introduction does not initialize the model; architecture steps use an isolated worker. The workbench uses the existing BrowserSession or local HTTP API.

The read-only `src/presentation-observer.js` records bounded representative frames and cumulative rejection/drop counts without changing model decisions. Six attack-family parity tests verify this. `simulation.js`, `datasets.js` and `experiments.js` remain unchanged. The production UI removes reviewer presets and recorder hooks, uses the existing import/export/validation paths, and keeps the strict content security policy by externalizing prototype inline styles.

See [R2 contract](SIGNAL-RESOLVE-CONTRACT.md). The remainder of this document describes the retained classic laboratory at `/laboratory/`.

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
- Tab entry uses a 300ms opacity/8px transform transition. Buttons use 160ms interactions. No extra animation runtime is loaded. Event-driven motion is listed under [Motion](#motion).
- Expand Network architecture to inspect the ESP32, STM32, Pi, safety task and protected ECU boundary.
- All controls remain keyboard accessible. Responsive targets are 1440×900 and 390×844; additional overflow checks cover 320, 768 and 1024px. On narrow screens experiment controls precede traffic history. Wide evidence tables and the expanded architecture diagram scroll inside their own panels.

## Motion

Each animation answers a real change in the model's state, and nothing moves just because it can. The one exception is the Inject attack hold ring, which shows the progress of the user's own press. Motion uses native CSS transitions and the Web Animations API only. Entrances use `--ease` (`cubic-bezier(.2,.8,.2,1)`), exits use `ease-in`, and only transform, opacity and color are animated. Nothing loops except the CAN dashes that mean "model running". CSS transitions switch on only after the first snapshot, so loading never animates. The gateway level, badge and gauge colors are written as `oklch()` values that match the original hex colors exactly. Browsers blend two hex colors in gamma-encoded sRGB, which muddies the midpoint; with `oklch()` colors, transitions blend in Oklab instead. That is the same aim as Motion's linear-light color mixing.

At most one attention animation plays at a time. `attend()` in `web/app.js` ranks them: gateway pulse, then safety banner, then timeline, inspector and chart. A higher-ranked animation finishes a lower one early. A lower-ranked one that is blocked is skipped, and its content appears without motion. Animations only play in the visible view.

| # | Animation | Trigger (model state) | Duration | Reduced motion |
| --- | --- | --- | --- | --- |
| 1 | Gateway level: the STM32 chip, topology gateway node, threat badge and gauge (`scaleX`) change color together; an outward ring pulses from the chip | `status` moves between OBSERVE, WARN, FILTER and REQUEST_DEGRADE. The pulse plays on escalation only | 350 ms transition; 600 ms single pulse | Colors and gauge change instantly; no pulse |
| 2 | Attack live: 2 px red left edge on the attack console and a thin red tint on topology CAN A | `activeAttacks` is non-empty **and** the model is running. Paused or imported sessions never show it | 200 ms in, 400 ms out (`ease-in`) | Instant opacity change |
| 3 | Timeline: a new row slides down 6 px while fading in; a severity-tinted background fades out | New event ids at the top of `events`, at most 5 per update. Existing rows are kept, not rebuilt | 220 ms entrance; 1.2 s highlight | Rows appear instantly, no highlight |
| 3 | Safety banner above the timeline (Degradation requested / Degraded · safety latched / Normal operation restored, with simulated time) | `safety.state` changes. It stays until the next change and clears on reset or import. The timeline list gives up the banner's height so the panel does not grow | 250 ms entrance | Appears instantly |
| 4 | Inspector: new rows fade in; only bytes that differ from the previous retained frame with the same CAN ID are highlighted | A live update adds 1–5 visible frames, e.g. a filtered ID or Step. Filter changes, held views and larger bursts never animate | 150 ms fade; 600 ms byte highlight | Rows appear instantly, no highlight |
| 5 | Chart: lines draw in left to right (clip rect `scaleX`); later updates rewrite path attributes in place; shaded windows with a 2 px top edge mark injected attacks | Draw-in: the first time a session's chart has a line, which takes two one-second samples. Shading: `activeAttacks` start and end times; an early stop uses the engine's "Attack sources stopped" time. Frame ground-truth labels never shade | 700 ms, once per session | Chart appears complete; shading unchanged |
| 6 | Inject attack hold ring: two clipped half rings rotate in turn around the ϟ glyph (transform only, linear because it shows elapsed time). The attack fires when the ring animation finishes, so the visible ring is the timer. One press arms the button ("Confirm injection", announced through a status region) and a second press injects. Escape, blur, a form change or 5 s disarm it | A primary pointer held on the button: the main mouse button, or the first touch or pen contact; a second finger is ignored. As in Motion's press gesture, release and cancel are tracked on the window. Drift up to 16 px off the button keeps the hold; moving further, releasing early, or a pointer cancel (for example a scroll) resets it. Keyboard and assistive technology use press, then confirm, and a held Enter key's auto-repeat never confirms | 600 ms hold; 120 ms track fade | The hold still injects after 600 ms on a timer, but the ring does not move; the track and armed color change instantly |
| 7 | Tab underline slides between tabs (`translateX` + `scaleX`); the existing panel entry is kept | Tab selected by click or arrow keys. Resizes and font loads move it without animation | 300 ms | Underline and panel switch instantly |
| 8 | Static skeleton bars replace zeros and "Connecting…" in readouts | Shown until the first snapshot, then replaced instantly with no transition and no layout shift | Static, no shimmer | Same |

A single click no longer injects. The browser checks confirm each injection: `scripts/browser-check.mjs` covers keyboard confirm, the 600 ms hold and click confirm, and checks that exactly one attack is added; `scripts/site-browser-check.mjs` uses press then confirm.

Limitation: attack shading covers only attacks this page observed in `activeAttacks`. Snapshots carry no past attack ranges, so if the page is reloaded after an attack ends, that window is not shaded.

## Verification and maintenance

Run `scripts/browser-check.mjs` with Playwright and Chrome available. It drives the real local engine, including all four views, offline recovery, signal selection, normal/reduced motion and the analyst toggle. Screenshots and the evidence record are in `artifacts/browser/`. Review screenshots as well as assertions; this is not a complete accessibility audit.

`styles.css` retains shared functional layout rules; `workbench.css` supplies the new theme, typography, vehicle schematic and responsive composition after it. Tabler and theme tokens load first. Before-redesign files are retained under `artifacts/redesign-before/` for comparison.
