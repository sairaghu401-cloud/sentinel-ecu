# Validation methodology

The automated suite is evidence about this software model. It does not establish vehicle safety, physical real-time performance, or accuracy on untested real vehicles.

## Repeatable experiments

Each case uses an explicit seed, a fresh engine and a declared synthetic driving profile. The analyst's synthetic training sample is distinct from the evaluation run. The suite exercises clean traffic, six attack families, loss of the analyst, safety escalation, recovery, and repeatability. Required checks are included in each result rather than inferred from a green visual status.

Run `npm run validate` to save the experiment artifact. The dashboard executes the same evaluator in an isolated worker. A suite with a failed required check is a failed result even if aggregate detection metrics look favorable.

Urban and Highway are **separate synthetic profiles**, each evaluated with its own profile-specific synthetic normal training. This is neither cross-profile transfer nor external cross-dataset validation. Importing a real CSV without fitting its schema is not a valid accuracy experiment. For real cross-dataset work, document each dataset's source/license, train/test split, ID mapping, payload interpretation, label provenance and preprocessing; fit only on training data and evaluate held-out files with unchanged rules.

## Metrics

Detection metrics use labelled frames only. A positive decision is a frame blocked by the gateway. Drop behavior is tracked separately and described in the experiment report; a queue drop is not automatically a true-positive detection. An allowed attack contributes a false negative. A blocked legitimate frame contributes a false positive.

| Metric | Calculation |
|---|---|
| Precision | TP / (TP + FP) |
| Recall | TP / (TP + FN) |
| False-positive rate | FP / (FP + TN) |

Undefined ratios are `null`, displayed as unavailable rather than 100%. Cumulative engine counts and retained-frame evaluator counts can have different populations after buffer truncation. The baseline and Sentinel comparison use exactly the same retained labelled frames. The report discloses retained versus total counts and should be read with that limitation.

The baseline blocks an ID absent from the configured whitelist and allows other frames. This is an intentionally simple comparison. The scenario generator uses known attack families, so high synthetic performance is not an estimate of unknown-attack performance.

Flooding overloads the modeled bus. Its acceptance check separately measures recall among inspected attack frames, while the main recall includes undetected congestion drops. This verifies filtering behavior without hiding availability loss. First-detection and safety-activation delays use simulated time relative to attack onset; they are not hardware measurements. Null delays mean that no corresponding detection or activation occurred.

Host processing measurements use the host's monotonic clock and include the implemented gateway operation, not a microcontroller instruction-cycle measurement. They vary with host load and runtime warm-up. Modeled serialization/queuing and safety delay use simulated time; they do not validate a particular STM32, CAN controller, FreeRTOS task schedule or physical actuator.

## Functional gates

- Clean runs forward normal traffic without unjustified safety escalation.
- Attack scenarios produce explainable evidence, with type-specific filtering expectations.
- Detection does not read truth labels. Changing only a label must not change a decision.
- The gateway continues forwarding and applying local rules when the analyst is disconnected.
- Safety activation requires a request and a distinct delayed acknowledgment.
- Degradation stays latched until explicit eligible recovery.
- Invalid input is rejected before changing the session.
- Replay is deterministic apart from measured host costs and report dates.
- Buffers remain bounded under high traffic.
- Parser errors include useful location/context, and labelled/unlabelled data is distinguished.
- API origin checks, body limits, static-file boundaries, SSE, exports and atomic saves are exercised.

## Browser verification

The interface is verified at 1440×900 and 390×844. The browser pass covers empty/loading, running, attack, Pi offline, validation pending/success, import errors, disconnect/reconnect, keyboard focus, and reduced-motion behavior. Screenshots and a local evidence record are retained in `artifacts/`. Browser verification complements the engine and API tests; it does not prove detection correctness.

Intensity calibration: overload and fast-drift acceptance benchmarks use level 4; other attack benchmarks use level 2. The safety lifecycle case uses level 5. See INTENSITY.md for exact presets and the separate 30-case comparison.

