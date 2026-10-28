# Public presentation contract

The introduction helps a first-time visitor understand Sentinel ECU and enter the existing simulator. The simulator remains an operational workbench with immediate controls. The core model, attack calibration, detector decisions, safety rules, import/export, API handlers and browser worker behavior are outside this visual change.

Design: soft white, warm gray, restrained burnt orange, system typography and an original vehicle/network SVG. The hero identifies the subject and offers the primary action in the first viewport. The system story explains Observe, Detect and Protect. Forge Automotive's scroll narrative and Jimo's guided product illustration informed the composition; see ANIMATION-DIRECTION.md for links. Public guides and the system illustration never present illustrative content as live telemetry.

Targets: 1440x900 desktop and 390x844 mobile, with additional 320, 768 and 1024 px overflow checks. All primary actions have visible focus and adequate touch space. Native page scrolling remains available. Reduced motion must leave every diagram and explanation understandable.

Loading: static HTML, system fonts and a dimensioned inline SVG render immediately. No model, worker or API connection starts on the public page. Content remains readable if its small enhancement script is unavailable.

Empty: the public introduction is editorial content and has no user-data empty state. The existing simulator's empty and paused states remain covered by its browser suite.

Error: unknown routes return a true 404. A public-script failure retains readable content and links. Existing simulator connection, validation and import errors remain covered by its browser suite.

Partial: illustrations and guides are labelled as such. A missing animation capability leaves all content visible. The hosted/local runtime distinction and model limits remain explicit.

Success: guide selection updates its explanation without layout movement or starting a run. Opening the lab starts the same existing paused simulation. Old root hash bookmarks reach the matching lab view.

Permission: not applicable to the public pages; no account, permission request, tracking service, upload or network control is added.

Evidence: screenshots, local performance observations, preserved-logic hashes and browser assertions live under artifacts/browser/launch/. Local timings are development checks, not field Core Web Vitals or an SEO ranking guarantee.
