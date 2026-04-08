import { useState, useRef, useCallback } from "react"
import { createFFmpeg, fetchFile } from "@ffmpeg/ffmpeg"
import "./style.css"

// ── Quality presets ────────────────────────────────────────────────────────
const QUALITY_PRESETS = [
  { label: "1080p", height: 1080, crf: 22 },
  { label: "720p",  height: 720,  crf: 23 },
  { label: "480p",  height: 480,  crf: 26 },
  { label: "360p",  height: 360,  crf: 28 },
  { label: "320p",  height: 320,  crf: 30 },
]

// ── Helpers ────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return "—"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  return (bytes / (1024 * 1024)).toFixed(1) + " MB"
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "--:--"
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

function parseHMS(h, m, s) {
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)
}

// ── Component ──────────────────────────────────────────────────────────────
export default function App() {
  const [videos, setVideos]               = useState([])
  const [compressedUrls, setCompressedUrls] = useState([])
  const [compressingIndex, setCompressingIndex] = useState(null)
  const [quality, setQuality]             = useState(QUALITY_PRESETS[1]) // 720p default
  const [progress, setProgress]           = useState({ percent: 0, fps: 0, speed: "", elapsed: 0, eta: 0 })
  const [isDragging, setIsDragging]       = useState(false)

  // Stable refs — never stale across closures
  const ffmpegRef    = useRef(null)
  const cancelledRef = useRef(false)
  const startRef     = useRef(0)
  const durationRef  = useRef(0)
  const timerRef     = useRef(null)

  // Lazy singleton — recreated after cancel/exit
  const getFFmpeg = useCallback(() => {
    if (!ffmpegRef.current) {
      ffmpegRef.current = createFFmpeg({ log: true })
    }
    return ffmpegRef.current
  }, [])

  // ── File handling ──────────────────────────────────────────────────────
  const acceptFiles = (files) => {
    const videos = files.filter((f) => f.type.startsWith("video/"))
    if (videos.length > 3) { alert("Maximum 3 videos allowed."); return }
    setVideos(videos)
    setCompressedUrls([])
  }

  const handleUpload  = (e) => acceptFiles(Array.from(e.target.files))
  const handleDrop    = (e) => { e.preventDefault(); setIsDragging(false); acceptFiles(Array.from(e.dataTransfer.files)) }
  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true) }
  const handleDragLeave = () => setIsDragging(false)

  // ── Cancel ─────────────────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    cancelledRef.current = true
    try { ffmpegRef.current?.exit() } catch (_) {}
    ffmpegRef.current = null           // force fresh instance next time
    clearInterval(timerRef.current)
    setCompressingIndex(null)
    setProgress({ percent: 0, fps: 0, speed: "", elapsed: 0, eta: 0 })
  }, [])

  // ── Compress ───────────────────────────────────────────────────────────
  const compressVideo = async (videoFile, index) => {
    cancelledRef.current = false
    setCompressingIndex(index)
    setProgress({ percent: 0, fps: 0, speed: "", elapsed: 0, eta: 0 })
    startRef.current   = Date.now()
    durationRef.current = 0

    // Tick elapsed every 500 ms
    timerRef.current = setInterval(() => {
      setProgress((p) => ({ ...p, elapsed: (Date.now() - startRef.current) / 1000 }))
    }, 500)

    const ffmpeg = getFFmpeg()
    if (!ffmpeg.isLoaded()) await ffmpeg.load()

    // Hook logger for real-time progress
    ffmpeg.setLogger(({ message }) => {
      const durM = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/)
      if (durM) durationRef.current = parseHMS(durM[1], durM[2], durM[3])

      const timeM = message.match(/time=(\d+):(\d+):(\d+\.?\d*)/)
      if (timeM && durationRef.current > 0) {
        const current  = parseHMS(timeM[1], timeM[2], timeM[3])
        const percent  = Math.min(99, (current / durationRef.current) * 100)
        const elapsed  = (Date.now() - startRef.current) / 1000
        const eta      = percent > 1 ? (elapsed / percent) * (100 - percent) : 0
        const fpsM     = message.match(/fps=\s*(\d+\.?\d*)/)
        const speedM   = message.match(/speed=\s*([\d.]+x)/)
        setProgress({
          percent: Math.round(percent),
          fps:     fpsM   ? parseFloat(fpsM[1])  : 0,
          speed:   speedM ? speedM[1]             : "",
          elapsed,
          eta,
        })
      }
    })

    try {
      const inputName  = videoFile.name
      const outputName = `compressed_${quality.label}_${inputName}`

      ffmpeg.FS("writeFile", inputName, await fetchFile(videoFile))

      await ffmpeg.run(
        "-i",         inputName,
        // ↓ Scale down to chosen height; -2 keeps aspect ratio & even pixel count
        "-vf",        `scale=-2:${quality.height}`,
        "-vcodec",    "libx264",
        // ── PERFORMANCE FLAGS ──────────────────────────────────────
        "-preset",    "veryfast",   // ~3× faster than default 'medium'
        "-crf",       String(quality.crf),
        "-threads",   "0",          // use all CPU cores
        "-movflags",  "+faststart", // moves moov atom to front for web
        // ── AUDIO ─────────────────────────────────────────────────
        "-acodec",    "aac",
        "-b:a",       "128k",
        outputName
      )

      const data = ffmpeg.FS("readFile", outputName)
      const blob = new Blob([data.buffer], { type: "video/mp4" })
      const url  = URL.createObjectURL(blob)

      // Clean up virtual FS
      try { ffmpeg.FS("unlink", inputName)  } catch (_) {}
      try { ffmpeg.FS("unlink", outputName) } catch (_) {}

      setProgress((p) => ({ ...p, percent: 100 }))
      setCompressedUrls((prev) => [
        ...prev,
        { name: inputName, url, size: blob.size, quality: quality.label },
      ])
    } catch (err) {
      if (!cancelledRef.current) console.error("Compression error:", err)
    } finally {
      clearInterval(timerRef.current)
      if (!cancelledRef.current) setCompressingIndex(null)
    }
  }

  const isCompressing = compressingIndex !== null

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="container">
      <header>
        <h1>🎬 Video Tool</h1>
        <p>Fast, private, browser-based compression — no uploads, no servers</p>
      </header>

      {/* ── Quality Selector ── */}
      <div className="quality-bar">
        <span className="quality-label">Output Resolution</span>
        <div className="quality-options">
          {QUALITY_PRESETS.map((q) => (
            <button
              key={q.label}
              className={`quality-btn${quality.label === q.label ? " active" : ""}`}
              onClick={() => setQuality(q)}
              disabled={isCompressing}
              title={`CRF ${q.crf}`}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Drop Zone ── */}
      <div
        className={`drop-zone${isDragging ? " dragging" : ""}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <span className="drop-icon">⬆</span>
        <p className="drop-label">Drag &amp; drop videos here, or</p>
        <label className="upload-btn" htmlFor="file-input">Choose Videos</label>
        <input id="file-input" type="file" accept="video/*" multiple onChange={handleUpload} />
      </div>

      {/* ── Video Cards ── */}
      {videos.length > 0 && (
        <div className="video-list">
          {videos.map((video, index) => {
            const isActive  = compressingIndex === index
            const isBlocked = isCompressing && !isActive
            return (
              <div key={index} className={`video-item${isActive ? " compressing-card" : ""}`}>
                <div className="video-meta">
                  <p className="video-name" title={video.name}>{video.name}</p>
                  <span className="file-size">{formatSize(video.size)}</span>
                </div>

                <video controls src={URL.createObjectURL(video)} />

                {/* Progress block — animated, only while compressing this card */}
                {isActive && (
                  <div className="progress-block">
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{ width: `${progress.percent}%` }}
                      >
                        <span className="progress-shimmer" />
                      </div>
                    </div>
                    <div className="progress-stats">
                      <span className="stat-badge pct">{progress.percent}%</span>
                      {progress.fps > 0 && (
                        <span className="stat-badge">{progress.fps} fps</span>
                      )}
                      {progress.speed && (
                        <span className="stat-badge speed">⚡ {progress.speed}</span>
                      )}
                      <span className="stat-badge elapsed">⏱ {formatTime(progress.elapsed)}</span>
                      {progress.eta > 1 && (
                        <span className="stat-badge eta">ETA {formatTime(progress.eta)}</span>
                      )}
                    </div>
                  </div>
                )}

                <div className="btn-row">
                  <button
                    className={`compress-btn${isActive ? " active" : ""}`}
                    onClick={() => compressVideo(video, index)}
                    disabled={isCompressing}
                  >
                    {isActive
                      ? <><span className="spinner" />Compressing…</>
                      : <>⚙ Compress</>
                    }
                  </button>
                  {isActive && (
                    <button className="cancel-btn" onClick={handleCancel}>
                      ✕ Cancel
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Compressed Results ── */}
      {compressedUrls.length > 0 && (
        <div className="compressed-list">
          <h2>✅ Compressed Videos</h2>
          {compressedUrls.map((c, i) => (
            <div key={i} className="compressed-item">
              <div className="video-meta">
                <p className="video-name" title={c.name}>{c.name}</p>
                <div className="badge-group">
                  <span className="quality-tag">{c.quality}</span>
                  <span className="file-size">{formatSize(c.size)}</span>
                </div>
              </div>
              <video controls src={c.url} />
              <a href={c.url} download={`compressed_${c.name}`} className="download-link">
                ⬇ Download
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}