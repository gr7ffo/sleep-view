import JSZip from 'jszip'
import Papa from 'papaparse'

const MAX_TEXT_FILE_BYTES = 12 * 1024 * 1024

type Scalar = string | number | boolean | null
type SqlRow = Record<string, Scalar>

export interface DailyMetric {
  date: string
  ahi: number | null
  usageHours: number | null
  leakRate: number | null
  pressure95: number | null
}

export interface SessionMetric {
  id: string
  start: string | null
  end: string | null
  durationMinutes: number | null
  machineId: string | null
  eventCount: number
}

export interface SleepDataModel {
  format: 'oscar-profile-backup' | 'sql-bundle' | 'csv-bundle'
  sourceFiles: number
  daily: DailyMetric[]
  sessions: SessionMetric[]
  machineUsage: { name: string; sessions: number }[]
  eventDistribution: { name: string; value: number }[]
  stats: {
    totalDays: number
    avgAhi: number | null
    avgUsageHours: number | null
    totalSessions: number
    totalRespiratoryEvents: number
  }
  warnings: string[]
}

export async function parseSleepArchive(file: File): Promise<SleepDataModel> {
  const zip = await JSZip.loadAsync(file)
  const files = Object.values(zip.files).filter((entry) => !entry.dir)

  const hasManifest = files.some((entry) => /(^|\/)manifest\.json$/i.test(entry.name))
  const sqlFiles = files.filter((entry) => /\.sql$/i.test(entry.name))
  const csvFiles = files.filter((entry) => /\.csv$/i.test(entry.name))

  if (hasManifest && sqlFiles.length > 0) {
    return parseSqlModel('oscar-profile-backup', sqlFiles, csvFiles)
  }

  if (sqlFiles.length > 0) {
    return parseSqlModel('sql-bundle', sqlFiles, csvFiles)
  }

  if (csvFiles.length > 0) {
    return parseCsvBundle(csvFiles)
  }

  throw new Error(
    'Unsupported ZIP layout. Supported formats are OSCAR profile backups (.oscar) and CSV-based exports.'
  )
}

async function parseSqlModel(
  format: SleepDataModel['format'],
  sqlFiles: JSZip.JSZipObject[],
  csvFiles: JSZip.JSZipObject[]
): Promise<SleepDataModel> {
  const tableRows: Record<string, SqlRow[]> = {}
  const warnings: string[] = []

  for (const file of sqlFiles) {
    const raw = await file.async('uint8array')
    if (raw.byteLength > MAX_TEXT_FILE_BYTES) {
      warnings.push(`Skipped large SQL file: ${file.name}`)
      continue
    }

    const content = new TextDecoder().decode(raw)
    const statements = extractInsertStatements(content)
    for (const statement of statements) {
      const rows = parseInsertRows(statement.columns, statement.values)
      if (!tableRows[statement.table]) {
        tableRows[statement.table] = []
      }
      tableRows[statement.table].push(...rows)
    }
  }

  const respiratoryEvents = tableRows.respiratory_events ?? []
  const sessions = tableRows.sessions ?? []
  const dailySummaries = tableRows.daily_summaries ?? []
  const machines = tableRows.machines ?? []

  const eventCountsBySession = new Map<string, number>()
  const eventDistributionMap = new Map<string, number>()
  for (const row of respiratoryEvents) {
    const sessionId = asString(
      firstPresent(row, ['session_id', 'sessionid', 'session'])
    )
    if (sessionId) {
      eventCountsBySession.set(sessionId, (eventCountsBySession.get(sessionId) ?? 0) + 1)
    }

    const eventName =
      asString(firstPresent(row, ['event_type', 'type', 'channel'])) ?? 'Unknown'
    eventDistributionMap.set(eventName, (eventDistributionMap.get(eventName) ?? 0) + 1)
  }

  const machineNameById = new Map<string, string>()
  for (const row of machines) {
    const machineId = asString(firstPresent(row, ['id', 'machine_id']))
    if (!machineId) continue
    const displayName =
      asString(firstPresent(row, ['model', 'product_name', 'name'])) ??
      asString(firstPresent(row, ['brand', 'manufacturer'])) ??
      `Machine ${machineId}`
    machineNameById.set(machineId, displayName)
  }

  const sessionMetrics: SessionMetric[] = sessions.map((row, index) => {
    const id = asString(firstPresent(row, ['id', 'session_id'])) ?? `session-${index + 1}`
    const machineId = asString(firstPresent(row, ['machine_id', 'machine']))
    const start = normalizeDateTime(firstPresent(row, ['start', 'start_time', 'session_start']))
    const end = normalizeDateTime(firstPresent(row, ['end', 'end_time', 'session_end']))
    const durationMinutes = normalizeDurationMinutes(row, start, end)

    return {
      id,
      start,
      end,
      durationMinutes,
      machineId,
      eventCount: eventCountsBySession.get(id) ?? 0,
    }
  })

  const dailyMetrics = buildDailyMetrics(dailySummaries)

  if (dailyMetrics.length === 0 && csvFiles.length > 0) {
    const csvFallback = await parseCsvBundle(csvFiles)
    csvFallback.warnings.unshift(...warnings)
    return csvFallback
  }

  const machineUsageMap = new Map<string, number>()
  for (const session of sessionMetrics) {
    const label =
      (session.machineId && machineNameById.get(session.machineId)) ??
      (session.machineId ? `Machine ${session.machineId}` : 'Unknown machine')
    machineUsageMap.set(label, (machineUsageMap.get(label) ?? 0) + 1)
  }

  const avgAhi = averageNumber(dailyMetrics.map((day) => day.ahi))
  const avgUsage = averageNumber(dailyMetrics.map((day) => day.usageHours))

  return {
    format,
    sourceFiles: sqlFiles.length + csvFiles.length,
    daily: dailyMetrics,
    sessions: sessionMetrics,
    machineUsage: [...machineUsageMap.entries()].map(([name, sessionsCount]) => ({
      name,
      sessions: sessionsCount,
    })),
    eventDistribution: [...eventDistributionMap.entries()].map(([name, value]) => ({
      name,
      value,
    })),
    stats: {
      totalDays: dailyMetrics.length,
      avgAhi,
      avgUsageHours: avgUsage,
      totalSessions: sessionMetrics.length,
      totalRespiratoryEvents: respiratoryEvents.length,
    },
    warnings,
  }
}

async function parseCsvBundle(csvFiles: JSZip.JSZipObject[]): Promise<SleepDataModel> {
  const warnings: string[] = []
  const pointsByDate = new Map<string, { ahi: number[]; usage: number[]; leak: number[] }>()

  for (const file of csvFiles) {
    const raw = await file.async('uint8array')
    if (raw.byteLength > MAX_TEXT_FILE_BYTES) {
      warnings.push(`Skipped large CSV file: ${file.name}`)
      continue
    }

    const content = new TextDecoder().decode(raw)
    const parsed = Papa.parse<Record<string, unknown>>(content, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    })
    if (parsed.errors.length > 0) {
      warnings.push(`CSV parse warning in ${file.name}: ${parsed.errors[0].message}`)
      continue
    }

    for (const row of parsed.data) {
      const dateValue = firstDateValue(row)
      if (!dateValue) continue

      const key = dateValue.slice(0, 10)
      if (!pointsByDate.has(key)) {
        pointsByDate.set(key, { ahi: [], usage: [], leak: [] })
      }

      const bucket = pointsByDate.get(key)!
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== 'number' || Number.isNaN(value)) continue
        const lowered = column.toLowerCase()
        if (lowered.includes('ahi')) bucket.ahi.push(value)
        if (lowered.includes('hour') || lowered.includes('usage') || lowered.includes('used')) {
          bucket.usage.push(value)
        }
        if (lowered.includes('leak')) bucket.leak.push(value)
      }
    }
  }

  const daily = [...pointsByDate.entries()]
    .map(([date, aggregates]) => ({
      date,
      ahi: averageNumber(aggregates.ahi),
      usageHours: averageNumber(aggregates.usage),
      leakRate: averageNumber(aggregates.leak),
      pressure95: null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    format: 'csv-bundle',
    sourceFiles: csvFiles.length,
    daily,
    sessions: [],
    machineUsage: [],
    eventDistribution: [],
    stats: {
      totalDays: daily.length,
      avgAhi: averageNumber(daily.map((day) => day.ahi)),
      avgUsageHours: averageNumber(daily.map((day) => day.usageHours)),
      totalSessions: 0,
      totalRespiratoryEvents: 0,
    },
    warnings,
  }
}

function extractInsertStatements(sql: string): { table: string; columns: string[]; values: string }[] {
  const statements: { table: string; columns: string[]; values: string }[] = []
  const regex = /INSERT\s+INTO\s+["`]?([a-zA-Z0-9_]+)["`]?\s*\(([^)]+)\)\s*VALUES\s*([\s\S]*?);/gi

  for (const match of sql.matchAll(regex)) {
    const table = match[1].toLowerCase()
    const columns = match[2]
      .split(',')
      .map((column) => column.trim().replace(/^["`]|["`]$/g, '').toLowerCase())
    const values = match[3].trim()
    statements.push({ table, columns, values })
  }

  return statements
}

function parseInsertRows(columns: string[], values: string): SqlRow[] {
  const tuples = splitTuples(values)
  return tuples
    .map((tuple) => parseTuple(tuple))
    .filter((items) => items.length === columns.length)
    .map((items) => {
      const row: SqlRow = {}
      columns.forEach((column, index) => {
        row[column] = parseScalar(items[index])
      })
      return row
    })
}

function splitTuples(values: string): string[] {
  const tuples: string[] = []
  let depth = 0
  let quote = false
  let start = -1

  for (let index = 0; index < values.length; index += 1) {
    const char = values[index]

    if (char === "'" && values[index - 1] !== '\\') {
      quote = !quote
    }
    if (quote) continue

    if (char === '(') {
      if (depth === 0) {
        start = index + 1
      }
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        tuples.push(values.slice(start, index))
      }
    }
  }

  return tuples
}

function parseTuple(tuple: string): string[] {
  const values: string[] = []
  let quote = false
  let token = ''

  for (let index = 0; index < tuple.length; index += 1) {
    const char = tuple[index]
    const next = tuple[index + 1]

    if (char === "'" && next === "'") {
      token += "''"
      index += 1
      continue
    }

    if (char === "'") {
      quote = !quote
      token += char
      continue
    }

    if (!quote && char === ',') {
      values.push(token.trim())
      token = ''
      continue
    }

    token += char
  }

  if (token.length > 0) {
    values.push(token.trim())
  }

  return values
}

function parseScalar(token: string): Scalar {
  const trimmed = token.trim()
  if (trimmed.length === 0 || /^null$/i.test(trimmed)) return null

  if (/^x'[0-9a-f]+'$/i.test(trimmed)) {
    const hex = trimmed.slice(2, -1)
    return `[blob:${Math.floor(hex.length / 2)} bytes]`
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed)
  }

  if (/^(true|false)$/i.test(trimmed)) {
    return /^true$/i.test(trimmed)
  }

  return trimmed
}

function buildDailyMetrics(rows: SqlRow[]): DailyMetric[] {
  return rows
    .map((row) => {
      const dateValue = normalizeDate(firstPresent(row, ['date', 'day', 'summary_date']))
      if (!dateValue) return null

      return {
        date: dateValue,
        ahi: asNumber(firstPresent(row, ['ahi', 'ahi_total', 'ahi_all'])),
        usageHours: asNumber(firstPresent(row, ['hours', 'usage_hours', 'used_hours', 'session_hours'])),
        leakRate: asNumber(firstPresent(row, ['leak', 'leak_rate', 'leak_median'])),
        pressure95: asNumber(firstPresent(row, ['pressure_95', 'pressure95', 'pressure'])),
      }
    })
    .filter((row): row is DailyMetric => row !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function normalizeDurationMinutes(row: SqlRow, start: string | null, end: string | null): number | null {
  const direct = asNumber(firstPresent(row, ['duration_minutes', 'duration', 'minutes']))
  if (direct !== null && direct > 0) return direct
  if (!start || !end) return null

  const startDate = new Date(start)
  const endDate = new Date(end)
  const minutes = (endDate.getTime() - startDate.getTime()) / 60000
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null
}

function normalizeDate(value: Scalar | undefined): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (text.length === 0) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text

  const date = new Date(text)
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10)
  }
  return null
}

function normalizeDateTime(value: Scalar | undefined): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epochSeconds = value > 9_999_999_999 ? value / 1000 : value
    return new Date(epochSeconds * 1000).toISOString()
  }

  const text = String(value).trim()
  if (!text) return null
  const date = new Date(text)
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString()
  }

  return null
}

function firstDateValue(row: Record<string, unknown>): string | null {
  for (const value of Object.values(row)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const normalized = normalizeDateTime(value)
    if (normalized) return normalized
  }

  for (const [key, value] of Object.entries(row)) {
    if (!/(date|day|time|timestamp)/i.test(key)) continue
    const normalized = normalizeDateTime(value as Scalar)
    if (normalized) return normalized
  }

  return null
}

function firstPresent(row: SqlRow, keys: string[]): Scalar | undefined {
  for (const key of keys) {
    if (key in row) return row[key]
  }
  return undefined
}

function asString(value: Scalar | undefined): string | null {
  if (value === undefined || value === null) return null
  return String(value)
}

function asNumber(value: Scalar | undefined): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function averageNumber(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (numbers.length === 0) return null
  const sum = numbers.reduce((acc, value) => acc + value, 0)
  return sum / numbers.length
}
