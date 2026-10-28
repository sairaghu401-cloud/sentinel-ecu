# Sentinel ECU animation and search direction

Historical research: 27 October 2026. Superseded on 28 October by the user-approved Claude Signal Resolve R2 export; see SIGNAL-RESOLVE-CONTRACT.md. The user subsequently approved implementation. The public introduction, architecture chapters, control guide, explanation pages and search metadata are implemented locally; public deployment is a separate release step. See PRESENTATION-CONTRACT.md for the delivery constraints.

## Recommended composition

Keep the soft white, light gray and burnt-orange palette. Give the public introduction a large original vehicle/network diagram, concise typography and one purposeful sequence showing traffic, detection and protection. Keep the operational dashboard immediately usable, with motion tied to confirmed simulation state.

The current application already implements tab transitions, gateway pulses, timeline highlights, chart entrances and hold feedback. Refine and test those instead of layering competing effects over them. The major addition should be an explanatory public introduction, with a prominent Open simulator link.

## Selected references

The Awwwards animation gallery was inspected in the browser, followed by the Forge Automotive entry and live Forge and Jimo sites. Named Forge elements below are listed on its Awwwards entry; their adaptation to Sentinel is a design proposal, not a claim that those sites implement an ECU simulation.

| Reference | Pattern to adapt | Sentinel implementation |
| --- | --- | --- |
| [Forge: Introduction Scrubbing](https://www.awwwards.com/inspiration/introduction-scrubbing-forge-automotive) | Introduction progresses with scrolling | An original SVG vehicle expands into its CAN architecture as the reader moves through three short sections. Reveal the gateway and separate analyst/safety paths in sequence. Normal browser scrolling; all explanatory text remains readable without motion. |
| [Forge: USP Section](https://www.awwwards.com/inspiration/usp-section-forge-automotive) | Numbered story sections with coordinated visual changes | 01 Observe traffic, 02 Detect suspicious evidence, 03 Apply protection. On desktop the diagram stays beside the explanation; on phones use stacked sections. A separately labelled illustration must not imply every attack causes safety degradation. |
| [Forge: Clip-Path Menu Transition](https://www.awwwards.com/inspiration/clip-path-menu-transition-forge-automotive) | A contained reveal gives navigation a coherent transition | Use a small 180–250 ms reveal for an architecture/details panel. Preserve keyboard focus and immediate control response. Retain the existing always-visible dashboard navigation. |
| [Jimo](https://jimo.ai/) / [Awwwards entry](https://www.awwwards.com/sites/jimo-adoption-agent) | Product UI illustration with contextual guidance | An optional guided example highlights Select scenario, Choose intensity and Inspect evidence. Require a deliberate start. A sample preview is clearly identified; any live demonstration uses its own isolated simulation. |

Forge uses a dark automotive presentation; the useful reference is its sequence and hierarchy. Sentinel retains its existing light color direction. No source code, car photography, brand assets or paid templates from these sites are needed.

## Motion specification

- Introduction: one SVG outline/path reveal, approximately 650–900 ms on entry; keep heading and Open simulator action available immediately.
- Story sections: approximately 250–350 ms transitions between diagram states; convey the same sequence with static diagrams for reduced motion.
- Vehicle hotspots: 140–180 ms outline/label feedback on hover and keyboard focus; selecting a hotspot retains its current real target behavior.
- Live detection: a single brief emphasis on confirmed status change. Update numeric readings immediately and preserve exact values. Keep gateway filtering, Pi payload assessment and vehicle safety visually distinct.
- Intensity: explain each selected level with its actual configured rate/fraction. Display detected severity from observed model evidence, independently of the selected attack level.
- Stop decorative movement outside the visible page and when reduced motion is requested. Do not make motion a prerequisite to understanding or operating the model.

Use the existing CSS, SVG and Web Animations capabilities for these effects. Consider an additional animation dependency only if the prototype demonstrates a specific need. Test keyboard focus, touch cancellation, mobile scrolling, reduced motion and the earlier review findings before publishing. The October 16 review is historical; re-check the current implementation before assuming its findings remain unfixed.

## Search visibility

Animation is a presentation choice, not an SEO requirement. Google documents crawlable content, descriptive titles, canonical URLs and useful page experience separately from visual design.

Current source inspection found a title and meta description already present. The main views are buttons/hash states within a single dashboard; the inspected page head has no canonical or social-preview metadata, and no sitemap/robots source files were found.

Implemented public structure:

- `/`: readable project introduction and the animation described above.
- `/simulator/`: the interactive laboratory, with existing bookmarked dashboard links redirected or otherwise preserved during migration.
- `/how-it-works/`: gateway, analyst and independent safety architecture.
- `/attack-scenarios/`: six attack families and what each intensity means.
- `/validation/`: methodology, reproducible synthetic results and explicit model limits, without implying hardware certification.

Serve useful text and normal links in the initial HTML. Give each public page a meaningful title, description and canonical URL. Add a sitemap and appropriate crawler configuration; add social-preview metadata for shared links. Search text should naturally explain CAN bus security simulation and ECU anomaly detection, without keyword stuffing or invented results.

Performance targets to measure after implementation: LCP at or below 2.5 seconds, INP at or below 200 ms and CLS at or below 0.1 at the 75th percentile. These are targets, not measurements of the current project or a ranking guarantee. Load the live simulation workers when the lab is opened rather than as a prerequisite to reading the introduction.

Primary guidance: [Google JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics), [Google Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals).

Implementation order: public introduction and architecture sequence; guided example and dashboard refinements; crawlable explanation pages and metadata; performance/accessibility verification; then deployment verification.
