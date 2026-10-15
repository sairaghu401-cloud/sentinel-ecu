# Attack intensity

Intensity configures the synthetic attack generator. It is not an input to the gateway rules, Pi classifier, risk accumulator or safety task. Their response comes from the generated traffic, target criticality and duration. The same final risk score can occur at different attack volumes after sustained evidence.

| Level | Flood: extra frames/s | Spoof/replay/fuzz: interval | Payload: corrupted target frames | Stealth: time to reach target |
| --- | ---: | ---: | ---: | ---: |
| 1 · Low | 100 | 500 ms | 10% | 5,000 ms |
| 2 · Moderate | 1,000 | 12 ms | 25% | 2,000 ms |
| 3 · High | 3,000 | 6 ms | 50% | 1,000 ms |
| 4 · Severe | 6,000 | 4 ms | 75% | 450 ms |
| 5 · Maximum | 15,000 | 3 ms | 100% | 180 ms |

These are model presets, not measured automotive threat categories. Normal traffic is additional to offered attack traffic. The CAN link remains limited to 500 kbit/s: levels below capacity need not cause queue drops. Fuzzing retains variable payload length and unknown identifiers, so bandwidth differs from fixed eight-byte floods.

Payload corruption is deterministically spaced using a percentage accumulator. Untouched target frames retain normal labels. Corrupted frames contain the same out-of-range command at every level; intensity changes their frequency. Stealth preserves the target transmission period while changing its drift ramp. Short attacks may finish before that ramp completes.

The preview describes the selected scenario's exact effect. Active attacks retain the level submitted at injection; changing the selector affects only future attacks. Event history and exported active-attack metadata record the level and description.

## Recorded comparison

Run `node scripts/intensity-report.js` to reproduce `artifacts/intensity-comparison.json`: six families × five levels, urban seed 42, battery 0x300, 1 second warmup, 5 seconds attack.

For that payload experiment, low intensity ended at risk 9.18 (WARN), moderate at 22.71 (WARN), and high through maximum at 100 (FILTER). Five low-intensity corrupted frames were blocked, compared with 50 at maximum. No battery-only case requested shutdown.

Low flooding offered 500 attack frames across the five-second window without queue drops. Maximum offered 75,000 and caused congestion drops. Both accumulated enough repeated gateway evidence to reach FILTER; low volume is not a guarantee of low detected risk.

The acceptance suite intentionally uses level 4 for the overload and fast-drift benchmarks, preserving their previous 6,000 frames/s and 450 ms workloads. Other attack benchmarks use level 2; the separate safety-lifecycle case uses level 5. The suite reports its configured levels. It does not claim all low-intensity attacks achieve the same recall. Unit tests cover generated traffic at every level.
