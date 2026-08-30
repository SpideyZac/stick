# Graph Report - stick  (2026-08-30)

## Corpus Check
- Corpus is ~22,076 words - fits in a single context window. You may not need a graph.

## Summary
- 379 nodes · 1075 edges · 11 communities
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 39 edges (avg confidence: 0.86)
- Token cost: 106,682 input · 0 output

## Community Hubs (Navigation)
- Ball Flight and Swing Synthesis
- Club Data and Mock IMU Source
- Spec Concepts and Design Rationale
- Package Dependencies
- Swing Detection State Machine
- Analysis Pipeline and Kinematics
- 3D Replay Scene
- Build and TypeScript Config
- Stats Readout and Unit Formatting
- App Icon Artwork

## God Nodes (most connected - your core abstractions)
1. `v3()` - 37 edges
2. `SwingDetector` - 27 edges
3. `synthesizeSwing()` - 26 edges
4. `ImuSample` - 23 edges
5. `SwingScene` - 22 edges
6. `Vec3` - 20 edges
7. `normalize()` - 19 edges
8. `rotate()` - 17 edges
9. `cross()` - 17 edges
10. `scale()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `Hand Speed from the Accelerometer` --semantically_similar_to--> `Impact Detection from Accel Spike`  [INFERRED] [semantically similar]
  README.md → PROMPT.md
- `No Driver Support` --semantically_similar_to--> `Driver Out of Scope`  [INFERRED] [semantically similar]
  README.md → PROMPT.md
- `Arm Length Position Constraint` --semantically_similar_to--> `No Double Integration for Position`  [INFERRED] [semantically similar]
  README.md → PROMPT.md
- `Gyro Bias Estimation` --semantically_similar_to--> `Zero Velocity Updates`  [INFERRED] [semantically similar]
  README.md → PROMPT.md
- `Accelerometer Bias Accuracy Floor` --rationale_for--> `Address Calibration`  [INFERRED]
  README.md → PROMPT.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Swing Capture and t=0 Anchoring Flow** — prompt_swing_start_detection, prompt_waggle_rejection, prompt_address_calibration, readme_two_stage_waggle_rejection, readme_gyro_bias_estimation [INFERRED 0.85]
- **Position Without Double Integration** — prompt_no_double_integration, prompt_orientation_quaternion, prompt_forward_kinematics, prompt_zero_velocity_update, readme_hand_speed_from_accelerometer, readme_arm_length_position_constraint, readme_two_segment_club_model [INFERRED 0.85]
- **Stick Pipeline Stages** — readme_imusource, readme_mockimusource, readme_swingdetector, readme_analyzeswing, readme_swinganalysis [EXTRACTED 1.00]
- **Favicon depicts club-at-address composition in the app dark palette** — public_favicon_app_icon, public_favicon_club_glyph, public_favicon_ball_glyph, public_favicon_dark_palette [INFERRED 0.75]

## Communities (11 total, 0 thin omitted)

### Community 0 - "Ball Flight and Swing Synthesis"
Cohesion: 0.08
Nodes (69): BALL, clamp(), classify(), estimateFlight(), integrate(), ShotShape, gaussian(), mulberry32() (+61 more)

### Community 1 - "Club Data and Mock IMU Source"
Cohesion: 0.07
Nodes (35): Club, CLUBS, ClubType, DEFAULT_CLUB_ID, getClub(), IMU_OFFSET_FROM_BUTT, MockImuSource, MockOptions (+27 more)

### Community 2 - "Spec Concepts and Design Rationale"
Cohesion: 0.07
Nodes (47): Locked Mobile Viewport, Root Mount Element, 3D Swing Visualization, Address Calibration, Ball Flight Estimate, BMI270 Sensor Setup, Canned Swing Fixtures, Club Length Table (+39 more)

### Community 3 - "Package Dependencies"
Cohesion: 0.05
Nodes (40): jsdom, dependencies, react, react-dom, three, devDependencies, jsdom, @testing-library/jest-dom (+32 more)

### Community 4 - "Swing Detection State Machine"
Cohesion: 0.13
Nodes (20): getSwing(), ImuSample, biasDps(), accelMagnitude(), DETECT, DetectState, magnitude(), mean() (+12 more)

### Community 5 - "Analysis Pipeline and Kinematics"
Cohesion: 0.18
Nodes (28): effectiveShaftLength(), BallFlight, SwingTruth, Quat, rotate(), add(), Vec3, calibrate() (+20 more)

### Community 6 - "3D Replay Scene"
Cohesion: 0.11
Nodes (12): clamp(), COLORS, lineGeometry(), placeSegment(), setLine(), SwingScene, TMP_DIR, TMP_GRIP (+4 more)

### Community 7 - "Build and TypeScript Config"
Cohesion: 0.08
Nodes (23): DOM, DOM.Iterable, ES2022, src, vite.config.ts, vitest/globals, compilerOptions, esModuleInterop (+15 more)

### Community 8 - "Stats Readout and Unit Formatting"
Cohesion: 0.24
Nodes (11): shapeLabel, StatsPanel(), DEGREE, FEET_PER_METER, fixed(), mph(), MPH_PER_MPS, sided() (+3 more)

### Community 9 - "App Icon Artwork"
Cohesion: 0.67
Nodes (4): Stick App Favicon, Golf Ball Glyph, Golf Club Glyph (shaft and head), Dark Green Brand Palette

## Knowledge Gaps
- **73 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+68 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SwingScene` connect `3D Replay Scene` to `Analysis Pipeline and Kinematics`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `SwingDetector` connect `Swing Detection State Machine` to `Club Data and Mock IMU Source`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `SwingAnalysis` connect `Analysis Pipeline and Kinematics` to `Stats Readout and Unit Formatting`, `Club Data and Mock IMU Source`, `3D Replay Scene`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _73 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Ball Flight and Swing Synthesis` be split into smaller, more focused modules?**
  _Cohesion score 0.08313285217856188 - nodes in this community are weakly interconnected._
- **Should `Club Data and Mock IMU Source` be split into smaller, more focused modules?**
  _Cohesion score 0.07393483709273183 - nodes in this community are weakly interconnected._
- **Should `Spec Concepts and Design Rationale` be split into smaller, more focused modules?**
  _Cohesion score 0.07215541165587419 - nodes in this community are weakly interconnected._