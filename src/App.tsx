import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'
import { parseSleepArchive, type SleepDataModel } from './lib/parser'

function App() {
  const [model, setModel] = useState<SleepDataModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isParsing, setIsParsing] = useState(false)

  const nightsWithAhiOver5 = useMemo(() => {
    if (!model) return 0
    return model.daily.filter((night) => (night.ahi ?? 0) > 5).length
  }, [model])

  const latestNights = useMemo(() => model?.daily.slice(-30) ?? [], [model])

  async function onFileChange(file: File | null) {
    if (!file) return
    setError(null)
    setModel(null)
    setIsParsing(true)

    try {
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
        <section className="dashboard">
          <div className="cards">
            <article className="card">
              <h2>{model.stats.totalDays}</h2>
              <p>Nights parsed</p>
            </article>
            <article className="card">
              <h2>{model.stats.avgAhi?.toFixed(2) ?? '—'}</h2>
              <p>Average AHI</p>
            </article>
            <article className="card">
              <h2>{model.stats.avgUsageHours?.toFixed(2) ?? '—'}</h2>
              <p>Avg usage hours</p>
            </article>
            <article className="card">
              <h2>{nightsWithAhiOver5}</h2>
              <p>Nights above AHI 5</p>
            </article>
          </div>

          <div className="chart-grid">
            <article className="panel">
              <h3>Nightly trend (last 30 nights)</h3>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={latestNights}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2b3652" />
                  <XAxis dataKey="date" tick={{ fill: '#b8c4e4', fontSize: 12 }} />
                  <YAxis yAxisId="ahi" tick={{ fill: '#b8c4e4', fontSize: 12 }} />
                  <YAxis yAxisId="usage" orientation="right" tick={{ fill: '#b8c4e4', fontSize: 12 }} />
                  <Tooltip />
                  <Line
                    yAxisId="ahi"
                    type="monotone"
                    dataKey="ahi"
                    stroke="#7dd3fc"
                    strokeWidth={2}
                    dot={false}
                    name="AHI"
                  />
                  <Line
                    yAxisId="usage"
                    type="monotone"
                    dataKey="usageHours"
                    stroke="#c4b5fd"
                    strokeWidth={2}
                    dot={false}
                    name="Usage hours"
                  />
                </LineChart>
              </ResponsiveContainer>
            </article>

            <article className="panel">
              <h3>Respiratory event distribution</h3>
              {model.eventDistribution.length === 0 ? (
                <p className="empty">No respiratory event table found in this archive.</p>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={model.eventDistribution.slice(0, 10)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2b3652" />
                    <XAxis dataKey="name" tick={{ fill: '#b8c4e4', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#b8c4e4', fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="#60a5fa" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </article>

            <article className="panel">
              <h3>Machine session mix</h3>
              {model.machineUsage.length === 0 ? (
                <p className="empty">No machine table found in this archive.</p>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={model.machineUsage}
                      dataKey="sessions"
                      nameKey="name"
                      outerRadius={100}
                      innerRadius={55}
                      label
                    >
                      {model.machineUsage.map((entry, index) => (
                        <Cell
                          key={entry.name}
                          fill={['#60a5fa', '#c084fc', '#22d3ee', '#34d399', '#fbbf24'][index % 5]}
                        />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </article>
          </div>

          {model.warnings.length > 0 && (
            <article className="panel warnings">
              <h3>Parse warnings</h3>
              <ul>
                {model.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </article>
          )}

          <article className="panel privacy-note">
            <h3>Privacy first</h3>
            <p>
              This app is fully client-side and intended for GitHub Pages deployment. Uploaded data is
              parsed in-memory and is never transmitted to any server.
            </p>
            <p>
              Parsed format: <strong>{model.format}</strong> • Source files: {model.sourceFiles} • Sessions:{' '}
              {model.stats.totalSessions}
            </p>
          </article>
        </div>
      )}
    </main>
  )
}

export default App
