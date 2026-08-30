# Stick

Turns raw IMU data from a BMI270 at the grip end of a golf club into swing stats,
a 3D swing reconstruction, and an estimated ball flight. Runs in a phone browser.

There is no hardware yet. The whole pipeline runs against a mock IMU stream, and
a real BLE sensor drops in behind the same interface without touching anything
downstream.

## Running it

```
npm install
npm run dev -- --host    # open the LAN address on your phone
npm test
npm run build
```

## How it fits together

```
ImuSource  ->  SwingDetector  ->  analyzeSwing  ->  SwingAnalysis  ->  UI
```

The UI knows about `SwingAnalysis` and nothing else. The pipeline knows about
`ImuSource` and nothing else.

| Area | Where |
| --- | --- |
| Sample source contract | `src/imu/types.ts` |
| Mock stream and canned swings | `src/imu/mock/` |
| Mount and world frame conventions | `src/swing/frames.ts` |
| Swing start detection | `src/swing/detect.ts` |
| Calibration, orientation, kinematics | `src/swing/{calibrate,orient,kinematics}.ts` |
| Phases and stats | `src/swing/{phases,stats}.ts` |
| Ball flight | `src/flight/ballflight.ts` |
| Replay | `src/three/scene.ts` |

## Adding a real sensor

Implement `ImuSource` and hand it to `SwingDetector` in place of
`MockImuSource`. That is the only change. The interface delivers samples in
batches because that is how BLE notifications arrive.

`src/imu/types.ts` carries the BMI270 constants the mock quantizes to: 16g and
2000 dps, which at 400 Hz is about 5.6 kB/s packed as int16. Both ranges have
headroom at high school swing speeds. The canned swings peak near 1850 dps and
16g, so they exercise the top of both.

## Things worth knowing

**The mock is physically consistent.** Acceleration is derived from the same
motion that generates the gyro trace, and the synthesizer swings the grip on a
real arc while the analysis assumes the grip is fixed. The two models differ on
purpose, so the pipeline is never tested against its own assumptions. Noise,
per-axis bias, and sensor quantization are all modelled.

**Yaw is unobservable.** No magnetometer, so nothing pins absolute heading. Over
a one second swing with the gyro bias removed the drift is small, and every angle
reported is relative to the address frame, so it does not matter. It would matter
over minutes, which is why t=0 anchors to the last moment of stillness rather
than to the record tap.

**The gyro bias does more work than the gravity corrections.** A couple of
degrees per second left in place integrates into several degrees across a swing,
which is larger than the face angles being reported. It is estimated from the
still window before takeaway, which is why that window leaves a guard band ahead
of t=0 and filters to genuinely quiet samples.

**Waggle rejection is in two stages.** A cheap check at 120ms commits to
capturing, which throws out most waggles at once and keeps t=0 accurate. A second
check at the end discards anything that got that far and never produced contact.
That is what catches a waggle big and slow enough to survive the first pass.
Buffering is cheap, so a provisional capture costs nothing when it turns out to
be wrong.

**Clubhead speed is a slight underestimate.** Forward kinematics puts the grip at
the origin, so hand travel is not counted. Every angle reported is directional
and unaffected. This is the tradeoff that keeps position as geometry instead of a
double integration of the accelerometer, which drifts hopelessly over a swing.

**No driver.** It is the one club that gets teed up, and the address calibration
assumes a grounded club.

## Verifying a change

`npm test` covers the chain. The one that matters most is the round trip in
`src/swing/pipeline.test.ts`: the synthesizer knows exactly what face angle,
path, and speed it produced, and the pipeline has to give those back from
nothing but noisy, biased, quantized samples. Face, path, and face to path
recover inside half a degree.
