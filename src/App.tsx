import { lazy, Suspense, useState } from 'react'
import './App.css'
import type { SleepDataModel } from './lib/parser'

const Dashboard = lazy(() => import('./components/Dashboard'))

function App() {
  const [model, setModel] = useState<SleepDataModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isParsing, setIsParsing] = useState(false)

  async function onFileChange(file: File | null) {
    if (!file) return
    setError(null)
    setModel(null)
    setIsParsing(true)

    try {
      const { parseSleepArchive } = await import('./lib/parser')
      const parsed = await parseSleepArchive(file)
      setModel(parsed)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not parse uploaded ZIP archive.')
    } finally {
      setIsParsing(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">Sleep View</p>
        <h1>Private sleep data insights, fully in your browser.</h1>
        <p className="hero-copy">
          Upload an OSCAR-style ZIP export to explore trends and nightly patterns. Data never leaves
          your device.
        </p>
        <label className="upload-panel" htmlFor="zip-upload">
          <span>Upload ZIP archive</span>
          <input
            id="zip-upload"
            type="file"
            accept=".zip,.oscar"
            onChange={(event) => void onFileChange(event.target.files?.[0] ?? null)}
          />
          <small>Supported: OSCAR profile backup SQL bundles and CSV-based ZIP exports.</small>
        </label>
        {isParsing && <p className="state">Parsing archive locally...</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {model && (
        <Suspense fallback={<p className="state">Loading dashboard…</p>}>
          <Dashboard model={model} />
        </Suspense>
      )}
    </main>
  )
}

export default App
