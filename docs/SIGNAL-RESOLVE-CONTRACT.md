# Signal Resolve — approved R2 implementation

Reference: user-approved sentinel-motion-preview.mp4 and sentinel-r2-closeup.mp4;
source layout and licensed fonts from sentinel-ecu-concept-r2.zip in Downloads.

Purpose: configure a repeatable CAN experiment and understand every recorded
gateway outcome. Primary action: Open simulator, then Run or Step.

Direction: preserve the reference's dark typographic introduction, warm ivory
workbench, Archivo/IBM Plex Mono, dithered vehicle, orange attack inputs, teal
forwarded frames, blue blocked frames and distinct queue drops. The diagram
persists through the introduction, architecture and workbench views.

Hierarchy: vehicle signals / message journey / attack and evidence. The four
status rows describe generator, gateway, analyst and independent safety.
Controls remain immediately responsive. Exact counters come from the model;
animated frames are a bounded representative sample, slowed for readability.

Constraints: no changes to simulation.js, datasets.js or experiments.js.
Keep the existing BrowserSession/HTTP commands, validation, import/export and
local persistence. Presentation observation must not affect model decisions.
Prototype reviewer presets and recorder hooks are excluded from production.
Initial introduction must not train or start a simulation. Architecture previews
are isolated from the user's workbench session. No external runtime requests.

Viewports: 1440x900 and 390x844, with additional overflow checks at 320 and 768.
Reduced motion must retain decision cards, static paths and receipt outcomes.
Keyboard focus, mobile controls, evidence pinning and confirmation are checked.

States:
- Loading: disabled model controls and visible initialization feedback.
- Empty: paused initial state and instructions to Run/Step; empty evidence.
- Error: visible connection/error message, retry or reload, controls disabled.
- Partial: imported or offline state is labeled; retained evidence stays readable.
- Success: actual attack/forward/block/drop and recovery state plus next action.
- Permission: no account or device permission is required for this local model.

Delivery is initially local. Publishing is a separate release operation.

Revision — continuous scroll / canvas-first simulator (28 October 2026):
Overview, Architecture and Simulator stay in normal document order. A passive
scroll listener updates the active navigation and moves one live renderer to
the visible section; inactive sections keep an inert schematic. Links remain
shortcuts, and scroll is never trapped or replaced with wheel gestures.

The simulator fills the available viewport below the fixed navigation. Vehicle,
attack, evidence, status and settings open in a single keyboard-accessible drawer.
The main canvas stays in place. The decision card sits outside the diagram;
CAN counters and outcome labels scale with its coordinate system. Native dialog
focus management and Escape dismissal apply. Small/zoomed viewports can scroll
when necessary, rather than clipping controls to force a fixed height.

Vehicle status refinement: at widths above 700px, the six live protected-ECU
readouts stay above the gateway decision in the right-hand column. At phone
widths the same DOM nodes move back into the Vehicle drawer; values are not
copied or simulated in a separate presentation model. Status includes an
explanation of the statistical Pi analyst, delayed observation and gateway holds.
