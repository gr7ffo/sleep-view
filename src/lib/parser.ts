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
  format: 'oscar-profile-backup' | 'sql-bundle' | 'csv-bundle' | 'raw-therapy-bundle'
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
  const edfFiles = files.filter((entry) => /\.edf$/i.test(entry.name))
  const pdatFiles = files.filter((entry) => /\.pdat$/i.test(entry.name))

  if (hasManifest && sqlFiles.length > 0) {
    return parseSqlModel('oscar-profile-backup', sqlFiles, csvFiles)
  }

  if (sqlFiles.length > 0) {
    return parseSqlModel('sql-bundle', sqlFiles, csvFiles)
  }

  if (edfFiles.length > 0) {
    return parseRawTherapyBundle(edfFiles, pdatFiles)
  }

  if (pdatFiles.length > 0) {
    return parseRawTherapyBundle([], pdatFiles)
  }

  if (csvFiles.length > 0) {
    return parseCsvBundle(csvFiles)
  }

  throw new Error(
    'Unsupported ZIP layout. Supported formats are OSCAR profile backups (.oscar), raw therapy EDF/PDAT exports, and CSV-based exports.'
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

async function parseRawTherapyBundle(
  edfFiles: JSZip.JSZipObject[],
  pdatFiles: JSZip.JSZipObject[]
): Promise<SleepDataModel> {
  const warnings: string[] = []
  const eventDistributionMap = new Map<string, number>()
  const sessions: SessionMetric[] = []
  const usageHoursByDate = new Map<string, number>()
  const machineUsageMap = new Map<string, number>()
  const rawTherapyFiles = [...edfFiles, ...pdatFiles]

  for (const file of rawTherapyFiles) {
    const raw = await file.async('uint8array')
    const header = /\.edf$/i.test(file.name)
      ? parseEdfHeader(raw, file.name)
      : parsePdatHeader(raw, file.name)
    warnings.push(...header.warnings)

    if (!header.start) {
      warnings.push(`Skipped raw therapy session without readable start time: ${file.name}`)
      continue
    }

    const machineId = header.machineId ?? inferMachineIdFromPath(file.name)
    const sessionId = file.name.split('/').pop() ?? file.name
    const end =
      header.durationMinutes !== null
        ? new Date(new Date(header.start).getTime() + header.durationMinutes * 60_000).toISOString()
        : null

    sessions.push({
      id: sessionId,
      start: header.start,
      end,
      durationMinutes: header.durationMinutes,
      machineId,
      eventCount: 0,
    })

    const date = header.start.slice(0, 10)
    if (header.durationMinutes !== null) {
      const usageHours = header.durationMinutes / 60
      usageHoursByDate.set(date, (usageHoursByDate.get(date) ?? 0) + usageHours)
    }

    const machineLabel = machineId ?? 'Unknown machine'
    machineUsageMap.set(machineLabel, (machineUsageMap.get(machineLabel) ?? 0) + 1)

    for (const label of header.signalLabels) {
      const normalized = normalizeSignalLabel(label)
      if (!normalized) continue
      eventDistributionMap.set(normalized, (eventDistributionMap.get(normalized) ?? 0) + 1)
    }
  }

  const daily: DailyMetric[] = [...usageHoursByDate.entries()]
    .map(([date, usageHours]) => ({
      date,
      ahi: null,
      usageHours,
      leakRate: null,
      pressure95: null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  sessions.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))

  return {
    format: 'raw-therapy-bundle',
    sourceFiles: rawTherapyFiles.length,
    daily,
    sessions,
    machineUsage: [...machineUsageMap.entries()].map(([name, sessionsCount]) => ({
      name,
      sessions: sessionsCount,
    })),
    eventDistribution: [...eventDistributionMap.entries()].map(([name, value]) => ({
      name,
      value,
    })),
    stats: {
      totalDays: daily.length,
      avgAhi: null,
      avgUsageHours: averageNumber(daily.map((day) => day.usageHours)),
      totalSessions: sessions.length,
      totalRespiratoryEvents: 0,
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

interface ParsedEdfHeader {
  start: string | null
  durationMinutes: number | null
  signalLabels: string[]
  machineId: string | null
  warnings: string[]
}

function parseEdfHeader(content: Uint8Array, fileName: string): ParsedEdfHeader {
  const warnings: string[] = []
  if (content.byteLength < 256) {
    warnings.push(`Skipped invalid EDF header (<256 bytes): ${fileName}`)
    return { start: null, durationMinutes: null, signalLabels: [], machineId: null, warnings }
  }

  const text = new TextDecoder('ascii').decode(content.subarray(0, Math.min(content.byteLength, 8192)))
  const patient = text.slice(8, 88).trim()
  const recording = text.slice(88, 168).trim()
  const dateField = text.slice(168, 176).trim()
  const timeField = text.slice(176, 184).trim()
  const dataRecordCount = parseInt(text.slice(236, 244).trim(), 10)
  const dataRecordDurationSeconds = Number.parseFloat(text.slice(244, 252).trim())
  const signalCount = parseInt(text.slice(252, 256).trim(), 10)

  const start = parseEdfDateTime(dateField, timeField)
  if (!start) {
    warnings.push(`Could not parse EDF start date/time for ${fileName}: "${dateField} ${timeField}"`)
  }

  let durationMinutes: number | null = null
  if (
    Number.isFinite(dataRecordCount) &&
    dataRecordCount > 0 &&
    Number.isFinite(dataRecordDurationSeconds) &&
    dataRecordDurationSeconds > 0
  ) {
    durationMinutes = (dataRecordCount * dataRecordDurationSeconds) / 60
  }

  const signalLabels: string[] = []
  if (Number.isFinite(signalCount) && signalCount > 0) {
    const labelOffset = 256
    const labelsByteLength = signalCount * 16
    if (content.byteLength >= labelOffset + labelsByteLength) {
      for (let index = 0; index < signalCount; index += 1) {
        const startByte = labelOffset + index * 16
        const endByte = startByte + 16
        const label = new TextDecoder('ascii').decode(content.subarray(startByte, endByte)).trim()
        if (label) signalLabels.push(label)
      }
    } else {
      warnings.push(`EDF signal label section is truncated for ${fileName}`)
    }
  }

  const machineId = sanitizeMachineLabel(recording) ?? sanitizeMachineLabel(patient)
  return { start, durationMinutes, signalLabels, machineId, warnings }
}

function parsePdatHeader(content: Uint8Array, fileName: string): ParsedEdfHeader {
  const warnings: string[] = []
  const contentSnippet = new TextDecoder('latin1').decode(
    content.subarray(0, Math.min(content.byteLength, 4096))
  )
  const inferredStart = inferDateTimeFromText(contentSnippet) ?? inferDateTimeFromText(fileName)
  if (!inferredStart) {
    warnings.push(`Could not infer start date/time from PDAT file: ${fileName}`)
  }

  const machineId = inferMachineIdFromPath(fileName)
  return {
    start: inferredStart,
    durationMinutes: null,
    signalLabels: ['PDAT session'],
    machineId,
    warnings,
  }
}

function parseEdfDateTime(dateField: string, timeField: string): string | null {
  const dateMatch = dateField.match(/^(\d{2})[.-](\d{2})[.-](\d{2})$/)
  const timeMatch = timeField.match(/^(\d{2})[.:-](\d{2})[.:-](\d{2})$/)
  if (!dateMatch || !timeMatch) return null

  const day = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const yy = Number(dateMatch[3])
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const second = Number(timeMatch[3])
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(yy) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null
  }

  const year = yy >= 85 ? 1900 + yy : 2000 + yy
  const iso = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (Number.isNaN(iso.getTime())) return null
  return iso.toISOString()
}

function sanitizeMachineLabel(value: string | null): string | null {
  if (!value) return null
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact || /^x+$/i.test(compact) || /^unknown$/i.test(compact)) {
    return null
  }
  return compact
}

function inferMachineIdFromPath(path: string): string | null {
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return parts[parts.length - 2]
}

function inferDateTimeFromText(value: string): string | null {
  const compactMatch = value.match(/(20\d{2})(\d{2})(\d{2})[^\d]?(\d{2})(\d{2})(\d{2})/)
  if (compactMatch) {
    const [, year, month, day, hour, minute, second] = compactMatch
    return new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      )
    ).toISOString()
  }

  const dashedMatch = value.match(
    /(20\d{2})[./-](\d{2})[./-](\d{2})[^\d]+(\d{2})[:.-](\d{2})[:.-](\d{2})/
  )
  if (dashedMatch) {
    const [, year, month, day, hour, minute, second] = dashedMatch
    return new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      )
    ).toISOString()
  }

  return null
}

function normalizeSignalLabel(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  const lowered = normalized.toLowerCase()
  if (lowered.includes('annotation') || lowered.includes('signal')) return null
  if (lowered.includes('flow limitation')) return 'Flow Limitation'
  if (lowered.includes('snore')) return 'Snore'
  if (lowered.includes('leak')) return 'Leak'
  if (lowered.includes('pressure')) return 'Pressure'
  if (lowered.includes('resp') || lowered.includes('apnea') || lowered.includes('hypop')) {
    return 'Respiratory signals'
  }
  return normalized
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
