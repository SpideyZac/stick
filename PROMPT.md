# Golf Swing Tracker - Build Prompt

Build a web app that runs in a phone browser (iOS Safari) and turns raw IMU data
from a BMI270 mounted at the grip end of a golf club into swing stats, a 3D
swing reconstruction, and an estimated ball flight.

No Bluetooth yet. Build the whole data pipeline around a mock IMU stream so
everything can be tested without hardware. Structure the input layer so a real
BLE connection can be swapped in later without touching the rest of the app.

Driver is out of scope for now, since it's the one club that gets teed up.
Irons, wedges, hybrids, and fairway woods are all in scope, they all get
swept off the ground so the address height calibration below applies to
all of them.

Comments in code should be short, plain, and only where the code isn't
self explanatory. No em dashes anywhere in code, comments, or UI text. Write
like a person, not like a summary bot.

## Sensor setup

- BMI270, accel + gyro only, no magnetometer.
- Mounted at the grip, sensor's forward axis faces the golfer at address,
  sitting above the clubhead.
- Sample shape: timestamp, ax, ay, az, gx, gy, gz.
- Accel range +/-16g, gyro range +/-2000 dps. Both are enough headroom for
  high school swing speeds, no need to design around faster swings right now.

## Mock data layer

Build a mock IMU stream generator that can produce a few canned swings
(good swing, slice-tendency swing, hook-tendency swing, waggle-then-swing)
as timestamped sample arrays, played back at a realistic rate. This is what
the rest of the app consumes during development. Isolate this behind an
interface so a real BLE data source can plug into the same interface later.

## Club data

Table of standard club lengths for irons, wedges, hybrids, and fairway
woods (4-iron through lob wedge, 3-wood through 7-wood, 2-hybrid through
5-hybrid is fine, driver excluded). Club length feeds directly into the
forward kinematics model below. Let the user pick a club before recording.

## Swing start detection

Recording starts when the user taps record, before they've settled into
their final address position. Do not treat that tap as swing start.

- After record is tapped, watch gyro magnitude for a stillness baseline
  (low magnitude, sustained).
- Waggles show up as short spikes that return to that baseline. Ignore them.
- Real takeaway is a threshold crossing that keeps climbing and holds above
  threshold for a minimum duration (100-150ms) instead of dropping back down.
- Once that's confirmed, walk back to the last true stillness point before
  it and use that as t=0 for all timing stats.
- Also check the motion is roughly monotonic in one rotational direction
  during that climb, a waggle tends to reverse direction, a real takeaway
  doesn't.

## Address calibration

During the stillness period right before takeaway, the club is grounded.
Use that moment to:

- Check clubhead height from the forward kinematics model against 0
  (ground). If it's off, something is miscalibrated, flag it.
- Capture this orientation as the "square to target" reference frame.
  Every face angle and path number later is measured relative to this.

## Orientation and position

Do not double integrate the accelerometer for position, it drifts badly
over a swing length window. Instead:

- Integrate the gyroscope into an orientation quaternion over time.
- Use forward kinematics for clubhead position: known club length plus
  the fixed IMU offset from the grip, rotated by the current orientation
  quaternion. This turns position into geometry instead of an integration
  problem.
- Apply zero velocity updates at address and at the top of the backswing
  (both near-zero angular velocity moments) to stop orientation error from
  building up across the swing.

## Stats to compute

- Swing tempo (backswing time : downswing time ratio)
- Backswing duration, downswing duration, transition pause at the top
- Peak angular velocity and when it happens
- Clubhead speed at impact (from angular velocity x club length at that
  instant)
- Swing plane angle
- Attack angle (vertical velocity component of clubhead near impact)
- Face angle at impact, relative to the address reference frame
- Swing path at impact (clubhead travel direction just before contact)
- Face to path difference (this drives hook/slice, not face to target)
- Impact detection from the accel spike

## Ball flight estimate

Not going for launch monitor accuracy, just a reasonable estimate.

- Dynamic loft from club's static loft plus attack angle.
- Launch angle from dynamic loft.
- Ball speed from clubhead speed x a smash factor constant per club type
  (use published typical values, roughly 1.33-1.38 for mid irons, lower
  for wedges).
- Use face to path difference as a spin axis proxy for curve direction and
  amount, we don't have real spin data.
- Feed clubhead speed, launch angle, and the spin axis proxy into a simple
  projectile model with drag to get carry distance and left/right curve.
  Hardcode a reasonable golf ball drag coefficient, doesn't need to be
  configurable.

## 3D visualization

Render the swing in 3D from address to impact (or through to finish if
data supports it), using the orientation quaternion and club length to
draw the shaft and clubhead position over time. Show the target line from
the address reference frame so path and face angle are visually obvious.
Keep it lightweight, this needs to run smoothly on a phone browser.

## Git

Commit after every fix, feat, or chore, no exceptions. Small, frequent
commits, not one giant dump at the end. Use conventional commit format
(feat:, fix:, chore:, refactor:, etc). Stay consistent with this the whole
way through the build.

## Performance

This needs to run smooth on a phone browser, not a dev machine. Keep the
math and rendering lightweight, avoid unnecessary re-renders, profile the
3D view if it starts dropping frames. Don't over-engineer, just don't be
wasteful either.

## UI

- Club picker before recording
- Big record button
- Post swing: stat readout (tempo, clubhead speed, face to path, estimated
  carry, curve direction) plus the 3D swing replay
- Should work fine one handed on a phone screen, this is getting used on
  a driving range or practice green