import { useEffect, useRef, useState } from 'react'
import type { SwingAnalysis } from '../swing/pipeline'
import { SwingScene } from '../three/scene'

/**
 * Container for the replay. React owns the mount point and the play button, and
 * the scene owns everything that happens per frame. The scrubber is written to
 * through a ref rather than React state so playback never triggers a render.
 */
export function SwingView({ analysis }: { analysis: SwingAnalysis }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<SwingScene | null>(null)
  const scrubRef = useRef<HTMLInputElement | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const scene = new SwingScene(mount)
    sceneRef.current = scene
    scene.onFrame((frame, total) => {
      const scrub = scrubRef.current
      if (!scrub) return
      scrub.max = String(total - 1)
      scrub.value = String(frame)
      if (!scene.isPlaying() && playingRef.current) {
        playingRef.current = false
        setPlaying(false)
      }
    })
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  // Mirrors `playing` so the frame callback can read it without re-subscribing.
  const playingRef = useRef(false)
  playingRef.current = playing

  useEffect(() => {
    sceneRef.current?.setSwing(analysis)
    setPlaying(false)
  }, [analysis])

  const toggle = () => {
    const scene = sceneRef.current
    if (!scene) return
    if (scene.isPlaying()) {
      scene.pause()
      setPlaying(false)
    } else {
      scene.play()
      setPlaying(true)
    }
  }

  return (
    <div className="swing-view">
      <div className="canvas-mount" ref={mountRef} />
      <div className="playback">
        <button type="button" className="play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '⏸' : '▶'}
        </button>
        <input
          ref={scrubRef}
          className="scrub"
          type="range"
          min={0}
          max={Math.max(1, analysis.clubheadPath.length - 1)}
          defaultValue={0}
          onChange={(e) => {
            sceneRef.current?.pause()
            setPlaying(false)
            sceneRef.current?.setFrame(Number(e.target.value))
          }}
        />
      </div>
      <p className="legend">
        <span className="key key-target" /> target line
        <span className="key key-trail" /> clubhead
        <span className="key key-face" /> face
      </p>
    </div>
  )
}
