# Architecture

## Runtime flow

```text
ESPN scoreboard / odds / injuries       MLB Stats API
                 │                           │
                 └──────── parsers ──────────┘
                              │
                   verified in-memory state
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
   production model      shadow pipeline     live game state
          │                   │                   │
    published output   raw → calibration      score / events
          └───────────────────┼───────────────────┘
                              │
                   point-in-time snapshot
                              │
                   browser local storage
                              │
        Slate / Game / Model / Performance / Data
                              │
                   optional Ballpark Live
```

The legacy prediction engine remains in `index.html` so existing data collection, market logic, grading, and browser persistence continue to work. New concerns are separated into focused plain-JavaScript modules:

- `js/model/pipeline.js` — pure base-model ensemble, calibration, and disagreement math.
- `js/model/walk-forward.js` — chronological splits, prior-only calibration, metrics, and feature ablation.
- `js/data/snapshots.js` — versioned pregame records, deep immutability, grading, parsing, and legacy labels.
- `js/ui/quant-lab.js` — application routing and purpose-built analytical views.
- `js/three/stadium-configs.js` — validated park parameters and explicit schematic fallback.
- `js/three/ballpark.js` — on-demand Three.js renderer and 2D SVG fallback.

## Ballpark Live

Configured parks reuse one geometry system rather than independent scene files. Wall points are converted from angle/distance parameters into field coordinates. Segments between official markers are procedural and labeled derived; unconfigured parks are fully schematic.

The renderer uses:

- a demand-driven frame loop;
- `IntersectionObserver` and document visibility checks;
- instanced seating and defensive-position markers;
- responsive pixel-ratio and shadow settings;
- six camera presets plus pointer control in Free mode;
- explicit geometry, material, renderer, observer, and animation disposal;
- a pinned, dynamically imported Three.js module;
- an SVG field when WebGL or the module import fails.

Live scores and probabilities update in the HTML overlay without reconstructing the scene. Pitch endpoints use measured plate coordinates. Because release-point and movement vectors are not guaranteed in the current feed path, the connecting curve is a derived visualization and says so in the UI.

## Data boundaries

Measured, derived, and schematic information are visually labeled. Missing inputs do not receive fabricated defaults that influence the model. Neutral model behavior is preferred over invented precision.

The application remains static. It has no server-side credential store and no database; forward snapshots stay in the current browser until the user exports them.
