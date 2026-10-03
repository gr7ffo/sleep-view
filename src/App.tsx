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
      setError(caught instanceof Error ? caught.message : 'Could not parse uploaded file.')
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
          Upload OSCAR exports or raw device ZIP bundles (EDF/PDAT) to explore trends and nightly patterns. Data never leaves
          your device.
        </p>
        <label className="upload-panel" htmlFor="sleep-data-upload">
          <span>Upload sleep data file</span>
          <input
            id="sleep-data-upload"
            type="file"
            accept=".zip,.oscar,.edf,.pdat"
            onChange={(event) => void onFileChange(event.target.files?.[0] ?? null)}
          />
          <small>Supported: .zip/.oscar archives and standalone raw therapy .edf/.pdat files.</small>
        </label>
        {isParsing && <p className="state">Parsing file locally...</p>}
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
