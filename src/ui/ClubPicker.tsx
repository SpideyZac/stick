import { CLUBS, type ClubType } from '../data/clubs'
import type { Handedness } from '../swing/frames'

const GROUPS: { type: ClubType; label: string }[] = [
  { type: 'wood', label: 'Fairway woods' },
  { type: 'hybrid', label: 'Hybrids' },
  { type: 'iron', label: 'Irons' },
  { type: 'wedge', label: 'Wedges' },
]

interface Props {
  clubId: string
  hand: Handedness
  onClub: (id: string) => void
  onHand: (hand: Handedness) => void
  onDone: () => void
}

export function ClubPicker({ clubId, hand, onClub, onHand, onDone }: Props) {
  const selected = CLUBS.find((c) => c.id === clubId)

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Pick your club</h1>
        <p className="muted">Driver is not supported, it is the one club that gets teed up.</p>
      </header>

      <div className="scroll">
        <div className="segmented" role="group" aria-label="Handedness">
          {(['right', 'left'] as const).map((h) => (
            <button
              key={h}
              type="button"
              className={h === hand ? 'segment on' : 'segment'}
              onClick={() => onHand(h)}
            >
              {h === 'right' ? 'Right handed' : 'Left handed'}
            </button>
          ))}
        </div>

        {GROUPS.map((group) => (
          <section key={group.type}>
            <h2 className="group-label">{group.label}</h2>
            <div className="club-grid">
              {CLUBS.filter((c) => c.type === group.type).map((club) => (
                <button
                  key={club.id}
                  type="button"
                  className={club.id === clubId ? 'club on' : 'club'}
                  onClick={() => onClub(club.id)}
                >
                  <span className="club-id">{club.id.toUpperCase()}</span>
                  <span className="club-loft">{club.loft}&deg;</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="screen-foot">
        <button type="button" className="primary" onClick={onDone}>
          Use {selected?.label ?? 'club'}
        </button>
      </footer>
    </div>
  )
}
