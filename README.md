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
| Hand motion from the accelerometer | `src/swing/grip.ts` |
| Phases and stats | `src/swing/{phases,stats}.ts` |
| Ball flight | `src/flight/ballflight.ts` |
| Replay | `src/three/scene.ts` |

## Adding a real sensor

Implement `ImuSource` and hand it to `SwingDetector` in place of
`MockImuSource`. That is the only change. The interface delivers samples in
batches because that is how BLE notifications arrive.

`src/imu/types.ts` carries the BMI270 constants the mock quantizes to: 16g and
2000 dps, which at 400 Hz is about 5.6 kB/s packed as int16. Both ranges have
headroom at high school swing speeds. The canned swings peak near 1880 dps and
16g, so they exercise the top of both.

## Things worth knowing

**The mock is physically consistent.** Acceleration is derived from the same
motion that generates the gyro trace, so the accelerometer sees exactly what that
swing would have produced. The synthesizer and the analysis still model the hands
differently on purpose: the synthesizer swings them on its own arc with its own
constants, and the analysis never sees those, it recovers hand motion from the
accelerometer alone. So the pipeline is not being graded against its own
assumptions. Noise, per-axis gyro and accelerometer bias, and sensor quantization
are all modelled.

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

**The hands are modelled, and they had to be.** The club is two segments: a hub
the arms pivot about, and the shaft. Pinning the grip at a point costs about
twenty percent of clubhead speed, because a good deal of it comes from the hands
travelling rather than the shaft rotating. It is not only an accuracy question.
Getting a 7 iron to 80 mph off a fixed grip needs over 2300 dps at the sensor,
past what a BMI270 can report at all, so the swing would not have been
representable in the first place.

**Hand speed is measured, not assumed.** The accelerometer is at the grip, so it
sees the grip's own acceleration. The spec rules out double integrating for
position and is right to, but velocity is one integration, not two, and it starts
from a boundary condition we know for free: the club is sitting still at address.
Over the second or so to impact that holds up, and it is checked against the
synthesizer's known hand motion in `src/swing/grip.test.ts`.

Position is still two integrations and still drifts. So the direction comes from
the integral and the distance comes from the arms, which is a fixed length and
cannot drift. That removes the radial error, the part that would visibly stretch
and squash the golfer's arms. What is left slides the hands slightly along their
own arc, which is hard to see. Only the replay depends on it; every number the
app reports comes from the velocity.

**Accelerometer bias sets a floor of about a degree.** A sensor sitting still
gives one vector, and there is no way to tell a tilted sensor from a sideways
biased one. That part gets absorbed into the address frame as a small tilt and
carries into every angle measured against it. Only the along-gravity component is
recoverable. Calibrating the accelerometer is what buys accuracy here, not
anything in this repo.

**No driver.** It is the one club that gets teed up, and the address calibration
assumes a grounded club.

## Verifying a change

`npm test` covers the chain. The one that matters most is the round trip in
`src/swing/pipeline.test.ts`: the synthesizer knows exactly what face angle,
path, and speed it produced, and the pipeline has to give those back from
nothing but noisy, biased, quantized samples. Face, path, and face to path
recover inside a degree, which is the accelerometer bias floor rather than the
maths. `src/swing/grip.test.ts` does the same for hand speed.
