# Stick

Turns motion data from a sensor on the shaft of a golf club into swing stats, a 3D
swing replay, and an estimated ball flight. Runs in a phone browser.

The sensor is an M5StickC S3 (BMI270 IMU) strapped to the shaft just below the
grip, talking to the browser over Web Bluetooth. Everything also runs against a
mock swing generator with no hardware attached, which is what the tests use.

## Running it

```
npm install
npm run dev -- --host    # open the LAN address on your phone
npm test
npm run build

cd hardware && pio run -t upload    # flash the Stick
```

## Layout

| Area                          | Where                   |
| ----------------------------- | ----------------------- |
| IMU source interface          | `src/imu/types.ts`      |
| BLE link and wire format      | `src/imu/ble/`          |
| Mock sensor and canned swings | `src/imu/mock/`         |
| Swing detection and analysis  | `src/swing/`            |
| Ball flight estimate          | `src/flight/`           |
| 3D replay                     | `src/three/`            |
| UI                            | `src/ui/`               |
| Firmware                      | `hardware/src/main.cpp` |

## Mounting the Stick

Strap it to the shaft just below the grip, tight enough that it cannot shift.
That is the whole instruction — which way up it goes does not matter.

The app works out the rotation between the chip and the club from your first
recorded swing: a still club at address reads gravity, so that gives up; the
backswing turns about the swing plane, whose normal at address is the forward
axis; and those two pin the frame. Nothing to enter, nothing to reflash, and
re-strapping it just means relearning from Calibrate. See `src/swing/mount.ts`.

The one thing a swing cannot tell it is where the target line really points —
azimuth is unobservable without a magnetometer — so it assumes you swung down
it. Teach it on a swing that feels normal: path angles afterwards are measured
against the plane you swung on that day.

## Notes

- Contact is found from the geometry of the swing, not from an acceleration
  threshold. The sensor is on the shaft, not the clubhead, so the shock that
  reaches it is small, varies with club and strike, and doesn't reliably clear
  the six or seven g the grip already pulls mid-downswing. What is reliable is
  that the club comes back through the address pose on the way down, which is
  visible in the gyro alone. See `src/swing/impact.ts`.
- The firmware sends the chip's own axes untouched and passes no judgement on
  orientation. The frame convention belongs to the pipeline that defines it, so
  that is where it is worked out.
- The firmware configures the BMI270 itself rather than taking M5Unified's
  defaults: ±16 g so the mid-swing loading doesn't clip, and 400 Hz so one sample
  is about a degree of club rotation instead of four.
- Raw counts go over the link untouched. The chip is set to exactly the ranges
  `src/imu/types.ts` assumes, so decoding is one multiply and there's nowhere for
  a unit to go wrong twice.
- The site pings the device once a second. Without that the device has no way to
  tell a closed browser tab from a quiet one, and would sit "connected" to
  nothing, refusing new connections.
- No driver support yet. It's the one club that's teed up rather than grounded, and
  the address calibration assumes the club is resting on the ground.
- The hands are modelled as their own moving part rather than a fixed pivot, since
  that's where a real chunk of clubhead speed comes from.
- Yaw drifts a little over time since there's no magnetometer, so every angle is
  measured relative to address rather than to true north.

`npm test` covers the full chain, including a round trip check where the mock
generator's known swing gets fed through detection and analysis and compared
against what it should recover.
