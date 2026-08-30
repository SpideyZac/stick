import { getClub } from '../data/clubs'
import { SWING_IDS, SWING_LABELS, type SwingId } from '../imu/mock/swings'
import { STATUS_TEXT, type RecorderStatus } from './useSwingRecorder'

interface Props {
  clubId: string
  status: RecorderStatus
  error: string | null
  mockSwing: SwingId
  onMockSwing: (id: SwingId) => void
  onStart: () => void
  onStop: () => void
  onChangeClub: () => void
}

export function RecordScreen({
  clubId,
  status,
  error,
  mockSwing,
  onMockSwing,
  onStart,
  onStop,
  onChangeClub,
}: Props) {
  const recording = status !== 'idle'

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="link" onClick={onChangeClub}>
          {getClub(clubId).label}
          <span className="chev"> change</span>
        </button>
      </header>

      <div className="record-body">
        <div className={`status status-${status}`}>
          <span className="status-dot" />
          {STATUS_TEXT[status]}
        </div>
        {error ? <p className="warning">{error}</p> : null}
        <p className="muted center">
          Tap record, then take your time getting set. Waggle all you like, the swing
          starts when you do.
        </p>
      </div>

      <footer className="screen-foot">
        {/* No hardware yet, so this stands in for which swing comes down the wire. */}
        <label className="dev-source">
          <span>Mock source</span>
          <select
            value={mockSwing}
            onChange={(e) => onMockSwing(e.target.value as SwingId)}
            disabled={recording}
          >
            {SWING_IDS.map((id) => (
              <option key={id} value={id}>
                {SWING_LABELS[id]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={recording ? 'record on' : 'record'}
          onClick={recording ? onStop : onStart}
        >
          {recording ? 'Stop' : 'Record'}
        </button>
      </footer>
    </div>
  )
}
