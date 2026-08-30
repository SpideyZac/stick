import { useEffect, useState } from 'react'
import { DEFAULT_CLUB_ID, getClub } from '../data/clubs'
import type { SwingId } from '../imu/mock/swings'
import type { Handedness } from '../swing/frames'
import { ClubPicker } from './ClubPicker'
import { RecordScreen } from './RecordScreen'
import { StatsPanel } from './StatsPanel'
import { SwingView } from './SwingView'
import { useSwingRecorder } from './useSwingRecorder'

type Screen = 'setup' | 'record' | 'results'

export function App() {
  const [screen, setScreen] = useState<Screen>('setup')
  const [clubId, setClubId] = useState(DEFAULT_CLUB_ID)
  const [hand, setHand] = useState<Handedness>('right')
  const [mockSwing, setMockSwing] = useState<SwingId>('good')

  const recorder = useSwingRecorder(clubId, hand, mockSwing)

  // A finished swing is the only thing that moves us to the results screen.
  useEffect(() => {
    if (recorder.analysis) setScreen('results')
  }, [recorder.analysis])

  if (screen === 'setup') {
    return (
      <div className="app">
        <ClubPicker
          clubId={clubId}
          hand={hand}
          onClub={setClubId}
          onHand={setHand}
          onDone={() => setScreen('record')}
        />
      </div>
    )
  }

  if (screen === 'results' && recorder.analysis) {
    return (
      <div className="app">
        <div className="screen">
          <header className="screen-head row">
            <h1>{getClub(clubId).label}</h1>
            <button
              type="button"
              className="link"
              onClick={() => {
                recorder.clear()
                setScreen('record')
              }}
            >
              Done
            </button>
          </header>
          <div className="scroll">
            <SwingView analysis={recorder.analysis} />
            <StatsPanel analysis={recorder.analysis} />
          </div>
          <footer className="screen-foot">
            <button
              type="button"
              className="primary"
              onClick={() => {
                recorder.clear()
                setScreen('record')
                recorder.start()
              }}
            >
              Hit another
            </button>
          </footer>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <RecordScreen
        clubId={clubId}
        status={recorder.status}
        error={recorder.error}
        mockSwing={mockSwing}
        onMockSwing={setMockSwing}
        onStart={recorder.start}
        onStop={recorder.stop}
        onChangeClub={() => {
          recorder.stop()
          setScreen('setup')
        }}
      />
    </div>
  )
}
