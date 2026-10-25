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
  format:
    | 'oscar-profile-backup'
    | 'sql-bundle'
    | 'csv-bundle'
    | 'raw-therapy-bundle'
    | 'prisma-pdat'
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
  const loweredName = file.name.toLowerCase()
  if (loweredName.endsWith('.edf')) {
    return parseRawTherapyFiles([
      {
        name: file.name,
        format: 'edf',
        read: async () => new Uint8Array(await file.arrayBuffer()),
      },
    ])
  }

  if (loweredName.endsWith('.pdat')) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const collector = createPrismaCollector()
    await collectPdatBytes(bytes, file.name, collector)
    return buildPrismaModel(collector)
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer())
  const sniffedRawFormat = sniffRawTherapyFormat(fileBytes)
  if (sniffedRawFormat) {
    if (sniffedRawFormat === 'pdat') {
      const collector = createPrismaCollector()
      await collectPdatBytes(fileBytes, file.name, collector)
      return buildPrismaModel(collector)
    }
    return parseRawTherapyFiles([
      {
        name: file.name,
        format: sniffedRawFormat,
        read: async () => fileBytes,
      },
    ])
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(fileBytes)
  } catch {
    throw new Error(
      'Unsupported file. Supported formats are OSCAR profile backups (.oscar/.zip), raw therapy EDF/PDAT exports, and CSV-based ZIP exports.'
    )
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir)

  const hasManifest = files.some((entry) => /(^|\/)manifest\.json$/i.test(entry.name))
  const sqlFiles = files.filter((entry) => /\.sql$/i.test(entry.name))
  const csvFiles = files.filter((entry) => /\.csv$/i.test(entry.name))
  const edfFiles = files.filter((entry) => /\.edf$/i.test(entry.name))
  const pdatFiles = files.filter((entry) => /\.pdat$/i.test(entry.name))

  if (hasManifest && sqlFiles.length > 0) {
    return parseSqlModel('oscar-profile-backup', sqlFiles, csvFiles)
  }

  const prismaEventEntries = files.filter((entry) => /event_\d+\.xml$/i.test(entry.name))
  const prismaSignalEntries = files.filter((entry) => /signal_\d+\.wmedf$/i.test(entry.name))
  if (prismaEventEntries.length > 0 || prismaSignalEntries.length > 0) {
    const collector = createPrismaCollector()
    await collectPrismaZipEntries(files, file.name, collector)
    return buildPrismaModel(collector)
  }

  function sniffRawTherapyFormat(content: Uint8Array): RawTherapyFileSource['format'] | null {
    if (looksLikeEdfContent(content)) return 'edf'
    if (looksLikePdatContent(content)) return 'pdat'
    return null
  }

  function looksLikeEdfContent(content: Uint8Array): boolean {
    if (content.byteLength < 256) return false
    const header = new TextDecoder('ascii').decode(content.subarray(0, 256))
    const dateField = header.slice(168, 176).trim()
    const timeField = header.slice(176, 184).trim()
    return parseEdfDateTime(dateField, timeField) !== null
  }

  function looksLikePdatContent(content: Uint8Array): boolean {
    const contentSnippet = new TextDecoder('latin1').decode(
      content.subarray(0, Math.min(content.byteLength, 4096))
    )
    if (/\bpdat\b/i.test(contentSnippet)) return true
    return inferDateTimeFromText(contentSnippet) !== null
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
  if (pdatFiles.length > 0) {
    // Weinmann/Löwenstein therapy exports win over the simple header sniffing path:
    // every PDAT payload goes through the structured prisma collector, which
    // understands ZIP-wrapped exports, plain WMEDF payloads and header-only
    // fallbacks.
    const collector = createPrismaCollector()
    if (edfFiles.length > 0) {
      collector.warnings.push(
        `Skipped ${edfFiles.length} EDF file(s) in favour of the structured prisma export (PDAT).`
      )
    }
    for (const pdatFile of pdatFiles) {
      const bytes = await pdatFile.async('uint8array')
      await collectPdatBytes(bytes, pdatFile.name, collector)
    }
    const model = buildPrismaModel(collector)
    return model
  }

  const rawTherapyFiles: RawTherapyFileSource[] = [
    ...edfFiles.map((file) => ({
      name: file.name,
      format: 'edf' as const,
      read: async () => file.async('uint8array'),
    })),
  ]
  return parseRawTherapyFiles(rawTherapyFiles)
}

interface RawTherapyFileSource {
  name: string
  format: 'edf' | 'pdat'
  read: () => Promise<Uint8Array>
}

async function parseRawTherapyFiles(rawTherapyFiles: RawTherapyFileSource[]): Promise<SleepDataModel> {
  const warnings: string[] = []
  const eventDistributionMap = new Map<string, number>()
  const sessions: SessionMetric[] = []
  const usageHoursByDate = new Map<string, number>()
  const machineUsageMap = new Map<string, number>()

  for (const file of rawTherapyFiles) {
    const raw = await file.read()
    const header =
      file.format === 'edf' ? parseEdfHeader(raw, file.name) : parsePdatHeader(raw, file.name)
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

const PRISMA_MACHINE_LABEL = 'Weinmann/Löwenstein prisma'

/** RespEventID taxonomy of Weinmann/Löwenstein prisma devices (per OSCAR prisma_loader). */
const PRISMA_RESP_EVENT_LABELS = new Map<number, string>([
  [1, 'Epoch: severe obstruction'],
  [2, 'Epoch: mild obstruction'],
  [3, 'Epoch: flow limitation'],
  [4, 'Epoch: snore'],
  [5, 'Epoch: periodic breathing'],
  [101, 'Obstructive apnea'],
  [102, 'Central apnea'],
  [103, 'Apnea (overview leak)'],
  [105, 'Apnea (high pressure)'],
  [106, 'Apnea (movement)'],
  [111, 'Obstructive hypopnea'],
  [112, 'Central hypopnea'],
  [113, 'Hypopnea (overview leak)'],
  [121, 'RERA'],
  [131, 'Snore'],
  [141, 'Artifact'],
  [151, 'Flow limitation'],
  [161, 'Critical leak'],
  [181, 'Cheyne-Stokes respiration'],
  [221, 'Timed breath'],
  [261, 'Epoch: deep sleep'],
])

/** RespEventIDs that contribute to the device AHI: apneas + hypopneas. */
const PRISMA_AHI_EVENT_IDS = new Set([101, 102, 103, 105, 106, 111, 112, 113])

interface Weighted {
  sum: number
  weight: number
}

interface PrismaRespEvent {
  id: number
  endTime: number
  duration: number
  pressure: number
  strength: number
}

interface PrismaEventXml {
  parameters: Map<number, number>
  respEvents: PrismaRespEvent[]
}

interface WmedfSignal {
  label: string
  unit: string
  bytesPerSample: number
  samplesPerRecord: number
  signed: boolean
  gain: number
  offset: number
}

interface WmedfFile {
  recordDurationSeconds: number
  signals: WmedfSignal[]
  headerBytes: number
  recordBytes: number
  recordCount: number
}

interface PrismaCollector {
  warnings: string[]
  eventDistribution: Map<string, number>
  ahiCountByDate: Map<string, number>
  usageSecondsByDate: Map<string, number>
  leakMedianByDate: Map<string, Weighted>
  pressureP95ByDate: Map<string, Weighted>
  sessions: SessionMetric[]
  machineSerial: string | null
  machineLabel: string | null
  sourceCount: number
}

function createPrismaCollector(): PrismaCollector {
  return {
    warnings: [],
    eventDistribution: new Map(),
    ahiCountByDate: new Map(),
    usageSecondsByDate: new Map(),
    leakMedianByDate: new Map(),
    pressureP95ByDate: new Map(),
    sessions: [],
    machineSerial: null,
    machineLabel: null,
    sourceCount: 0,
  }
}

/**
 * Routes a PDAT payload by content:
 * - `PK…` bytes → ZIP-wrapped therapy export (unzip + structured scan)
 * - `#s-1` marker → plain Weinmann WMEDF signal file
 * - otherwise → legacy heuristic header extraction
 */
async function collectPdatBytes(
  bytes: Uint8Array,
  fileName: string,
  collector: PrismaCollector
): Promise<void> {
  collector.sourceCount += 1

  if (bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = await JSZip.loadAsync(bytes)
    const entries = Object.values(zip.files).filter((entry) => !entry.dir)
    await collectPrismaZipEntries(entries, fileName, collector)
    return
  }

  const signals = parseWmedfFile(bytes)
  if (signals) {
    collectWmedfSignal(bytes, fileName, signals, collector)
    return
  }

  collector.warnings.push(
    `PDAT payload in ${fileName} contained no recognizable Weinmann data; falling back to heuristic header extraction.`
  )
  const header = parsePdatHeader(bytes, fileName)
  collector.warnings.push(...header.warnings)
  collectHeaderOnlySession(header, fileName, collector)
}

function collectHeaderOnlySession(header: ParsedEdfHeader, fileName: string, collector: PrismaCollector): void {
  if (!header.start) return
  const sessionId = fileName.split('/').pop() ?? fileName
  const end =
    header.durationMinutes !== null
      ? new Date(new Date(header.start).getTime() + header.durationMinutes * 60_000).toISOString()
      : null
  collector.sessions.push({
    id: sessionId,
    start: header.start,
    end,
    durationMinutes: header.durationMinutes,
    machineId: collector.machineLabel ?? 'prisma',
    eventCount: 0,
  })
  if (header.durationMinutes !== null) {
    addUsageSeconds(collector, header.start.slice(0, 10), header.durationMinutes * 60)
  }
  ensureMachineLabel(collector)
}

/** Machine info + session XML/WMEDF scan of an unzipped therapy export. */
async function collectPrismaZipEntries(
  entries: JSZip.JSZipObject[],
  archiveName: string,
  collector: PrismaCollector
): Promise<void> {
  const eventEntries = entries.filter((entry) => /event_\d+\.xml$/i.test(entry.name))
  const signalEntries = entries.filter((entry) => /signal_\d+\.wmedf$/i.test(entry.name))

  if (eventEntries.length === 0 && signalEntries.length === 0) {
    // Nested pdat payloads (e.g. a tar/zip bundle that itself contains *.pdat files)?
    const nestedPdat = entries.filter((entry) => /\.pdat$/i.test(entry.name))
    if (nestedPdat.length > 0 && nestedPdat.length < 500) {
      for (const entry of nestedPdat) {
        const bytes = await entry.async('uint8array')
        await collectPdatBytes(bytes, entry.name, collector)
      }
      return
    }
    collector.warnings.push(`No Weinmann prisma data found in ${archiveName}.`)
    return
  }

  await collectDeviceXml(entries, collector)

  const eventsBySessionId = new Map<number, PrismaEventXml>()
  for (const entry of eventEntries) {
    const sessionId = prismaSessionIdOf(entry.name)
    if (sessionId === null) continue
    eventsBySessionId.set(sessionId, parsePrismaEventXml(await entry.async('uint8array')))
  }

  const signalsBySessionId = new Map<number, JSZip.JSZipObject>()
  for (const entry of signalEntries) {
    const sessionId = prismaSessionIdOf(entry.name)
    if (sessionId === null) continue
    signalsBySessionId.set(sessionId, entry)
  }

  const sessionIds = [...new Set([...eventsBySessionId.keys(), ...signalsBySessionId.keys()])].sort(
    (a, b) => a - b
  )

  for (const sessionId of sessionIds) {
    const dayDate = prismaDayDateOf(entryNameFor(signalEntries, sessionId)) ?? prismaDayDateOf(entryNameFor(eventEntries, sessionId))
    const eventXml = eventsBySessionId.get(sessionId)
    const signalEntry = signalsBySessionId.get(sessionId)

    let start: string | null = null
    let durationSeconds: number | null = null

    if (signalEntry) {
      const bytes = await signalEntry.async('uint8array')
      const parsed = parseWmedfFile(bytes)
      if (parsed) {
        start = parseWmedfStart(bytes) ?? (dayDate ? `${dayDate}T00:00:00.000Z` : null)
        durationSeconds = parsed.recordCount * parsed.recordDurationSeconds
        collectWmedfStatistics(bytes, parsed, fileNameOf(signalEntry), dayDate, collector)
      } else {
        collector.warnings.push(`Could not parse WMEDF header of ${fileNameOf(signalEntry)}.`)
      }
    } else if (dayDate) {
      start = `${dayDate}T00:00:00.000Z`
    }

    let ahiCount = 0
    if (eventXml) {
      ahiCount = collectRespEvents(eventXml.respEvents, dayDate, collector)
    }

    const sessionIdLabel = `${dayDate ?? 'unknown-day'}/${String(sessionId).padStart(6, '0')}`
    const end =
      start !== null && durationSeconds !== null
        ? new Date(new Date(start).getTime() + durationSeconds * 1000).toISOString()
        : null

    collector.sessions.push({
      id: sessionIdLabel,
      start,
      end,
      durationMinutes: durationSeconds !== null ? durationSeconds / 60 : null,
      machineId: collector.machineSerial ?? collector.machineLabel ?? 'prisma',
      eventCount: ahiCount,
    })

    if (durationSeconds !== null && dayDate) {
      addUsageSeconds(collector, dayDate, durationSeconds)
    }
  }

  ensureMachineLabel(collector)
}

function fileNameOf(entry: JSZip.JSZipObject): string {
  return entry.name.split('/').pop() ?? entry.name
}

function entryNameFor(entries: JSZip.JSZipObject[], sessionId: number): string | null {
  for (const entry of entries) {
    if (prismaSessionIdOf(entry.name) === sessionId) return entry.name
  }
  return null
}

function prismaSessionIdOf(name: string): number | null {
  const match = name.match(/(?:event|signal)_(\d+)\./i)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

/** The per-night folder date next to a signal/event file ("20220328" → "2022-03-28"). */
function prismaDayDateOf(path: string | null): string | null {
  if (!path) return null
  const match = path.match(/\/(\d{8})\//)
  if (!match) return null
  const digits = match[1]
  if (!/^\d{8}$/.test(digits)) return null
  const year = digits.slice(0, 4)
  const month = Number(digits.slice(4, 6))
  const day = Number(digits.slice(6))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

async function collectDeviceXml(entries: JSZip.JSZipObject[], collector: PrismaCollector): Promise<void> {
  const deviceEntry = entries.find((entry) => /(^|\/)device\.xml$/i.test(entry.name))
  if (!deviceEntry) return
  const xml = new TextDecoder('latin1').decode(await deviceEntry.async('uint8array'))
  const serial = xml.match(/DeviceSerialNumber value="([^"]*)"/)?.[1]
  const fwVersion = xml.match(/FWVersion value="([^"]*)"/)?.[1]
  const fwBuild = xml.match(/FWBuild value="([^"]*)"/)?.[1]
  if (serial) collector.machineSerial = serial
  const buildName = fwBuild && /Eyra/i.test(fwBuild) ? ' Eyra' : ''
  collector.machineLabel = fwVersion
    ? `${PRISMA_MACHINE_LABEL}${buildName} FW ${fwVersion}`
    : `${PRISMA_MACHINE_LABEL}${buildName}`
}

function ensureMachineLabel(collector: PrismaCollector): void {
  if (!collector.machineLabel) {
    collector.machineLabel = `${PRISMA_MACHINE_LABEL} (WMEDF signal)`
  }
}

/**
 * Resp event taxonomy: distribution + per-day AHI event count.
 * Returns the AHI event count of this file.
 */
function collectRespEvents(
  respEvents: PrismaRespEvent[],
  dayDate: string | null,
  collector: PrismaCollector
): number {
  let ahiCount = 0
  for (const event of respEvents) {
    const label = PRISMA_RESP_EVENT_LABELS.get(event.id)
    if (!label) continue
    collector.eventDistribution.set(label, (collector.eventDistribution.get(label) ?? 0) + 1)
    if (PRISMA_AHI_EVENT_IDS.has(event.id)) ahiCount += 1
  }

  if (ahiCount > 0 && dayDate) {
    collector.ahiCountByDate.set(dayDate, (collector.ahiCountByDate.get(dayDate) ?? 0) + ahiCount)
  }
  return ahiCount
}

/** `<DeviceEvent … />` device parameters and `<RespEvent … />` events. */
function parsePrismaEventXml(content: Uint8Array): PrismaEventXml {
  const xml = new TextDecoder('latin1').decode(content)
  const parameters = new Map<number, number>()
  const respEvents: PrismaRespEvent[] = []

  for (const tag of xml.matchAll(/<DeviceEvent\s+([^>]*)\/>/g)) {
    const attributes = parseXmlAttributes(tag[1])
    if ((attributes.DeviceEventID ?? '0') !== '0') continue
    const parameterId = Number.parseInt(attributes.ParameterID ?? '', 10)
    const value = Number.parseInt(attributes.NewValue ?? '', 10)
    if (Number.isFinite(parameterId) && Number.isFinite(value)) {
      parameters.set(parameterId, value)
    }
  }

  for (const tag of xml.matchAll(/<RespEvent\s+([^>]*)\/>/g)) {
    const attributes = parseXmlAttributes(tag[1])
    const id = Number.parseInt(attributes.RespEventID ?? '', 10)
    if (!Number.isFinite(id)) continue
    respEvents.push({
      id,
      endTime: Number.parseInt(attributes.EndTime ?? '0', 10),
      duration: Number.parseInt(attributes.Duration ?? '0', 10),
      pressure: Number.parseInt(attributes.Pressure ?? '0', 10),
      strength: Number.parseInt(attributes.Strength ?? '0', 10),
    })
  }

  return { parameters, respEvents }
}

function parseXmlAttributes(attributes: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of attributes.matchAll(/(\w+)="([^"]*)"/g)) {
    result[match[1]] = match[2]
  }
  return result
}

/**
 * Weinmann WMEDF: an EDF-variant with ASCII fixed-width headers and per-signal
 * sample widths (`#1` = 8 bit, `#2` = 16 bit) at 1-second data records.
 */
function parseWmedfFile(content: Uint8Array): WmedfFile | null {
  if (content.byteLength < 1024) return null

  const markerText = decodeLatin1Slice(content, 0, Math.min(content.byteLength, 8192))
  const markerOffset = markerText.indexOf('#s-1')
  if (markerOffset < 0) return null

  const numbers = markerText.slice(markerOffset + 4, markerOffset + 104).match(/\d+/g) ?? []
  const recordDurationSeconds = numbers.length >= 2 ? Number(numbers[0]) : 1
  const signalCount = Number(numbers[numbers.length - 1])
  if (!Number.isFinite(signalCount) || signalCount <= 0 || signalCount > 64) return null
  if (
    !Number.isFinite(recordDurationSeconds) ||
    recordDurationSeconds < 0.01 ||
    recordDurationSeconds > 60
  ) {
    return null
  }

  const signalNames: string[] = []
  for (let index = 0; index < signalCount; index += 1) {
    signalNames.push(decodeLatin1Slice(content, 256 + index * 16, 16).trim())
  }

  const transducerOffset = 256 + signalCount * 16
  const unitsOffset = transducerOffset + signalCount * 80
  const physMinOffset = unitsOffset + signalCount * 8
  const physMaxOffset = physMinOffset + signalCount * 8
  const digMinOffset = physMaxOffset + signalCount * 8
  const digMaxOffset = digMinOffset + signalCount * 8
  const filterOffset = digMaxOffset + signalCount * 8
  const sampleCountOffset = filterOffset + signalCount * 80
  const reservedOffset = sampleCountOffset + signalCount * 8
  const headerBytes = reservedOffset + signalCount * 32
  if (content.byteLength < headerBytes) return null

  const readTextField = (offset: number, length: number) =>
    decodeLatin1Slice(content, offset, length).trim()
  const readNumberField = (offset: number, length: number) =>
    Number.parseFloat(readTextField(offset, length))

  const signals: WmedfSignal[] = []
  for (let index = 0; index < signalCount; index += 1) {
    const physMin = readNumberField(physMinOffset + index * 8, 8)
    const physMax = readNumberField(physMaxOffset + index * 8, 8)
    const digMin = readNumberField(digMinOffset + index * 8, 8)
    const digMax = readNumberField(digMaxOffset + index * 8, 8)
    const sampleCountText = readTextField(sampleCountOffset + index * 8, 8)
    const reserved = decodeLatin1Slice(content, reservedOffset + index * 32 + 30, 2)
    const bytesPerSample = reserved === '#2' ? 2 : 1
    const samplesPerRecord = Math.max(1, Number.parseInt(sampleCountText, 10) || 1)
    if (!Number.isFinite(physMin) || !Number.isFinite(physMax)) return null
    if (!Number.isFinite(digMin) || !Number.isFinite(digMax) || digMax === digMin) return null

    const gain = (physMax - physMin) / (digMax - digMin)
    signals.push({
      label: signalNames[index],
      unit: readTextField(unitsOffset + index * 8, 8),
      bytesPerSample,
      samplesPerRecord,
      signed: digMin < 0,
      gain,
      offset: physMin - gain * digMin,
    })
  }

  const recordBytes = signals.reduce(
    (total, signal) => total + signal.bytesPerSample * signal.samplesPerRecord,
    0
  )
  if (recordBytes <= 0) return null

  const available = content.byteLength - headerBytes
  if (available < 0) return null
  const recordCount = Math.floor(available / recordBytes)

  return {
    recordDurationSeconds,
    signals,
    headerBytes,
    recordBytes,
    recordCount,
  }
}

function decodeLatin1Slice(content: Uint8Array, offset: number, length: number): string {
  const decoder = new TextDecoder('latin1')
  return decoder.decode(content.subarray(offset, Math.min(offset + length, content.byteLength)))
}

/** WMEDF header: date at 168 ("dd.mm.yy"), time at 176 ("hh.mm.ss…"). */
function parseWmedfStart(content: Uint8Array): string | null {
  const dateField = decodeLatin1Slice(content, 168, 8).trim()
  const timeField = decodeLatin1Slice(content, 176, 12).trim()
  const start = parseEdfDateTime(dateField, timeField)
  if (start) return start

  const recording = decodeLatin1Slice(content, 88, 80)
  const recordingMatch = recording.match(/(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})/)
  if (!recordingMatch) return null
  const [, day, month, year, hour, minute, second] = recordingMatch
  const iso = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  )
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString()
}

/** Simplest WMEDF path: single signal session with per-channel statistics. */
function collectWmedfSignal(
  content: Uint8Array,
  fileName: string,
  wmedf: WmedfFile,
  collector: PrismaCollector
): void {
  if (wmedf.recordCount <= 0) {
    collector.warnings.push(`WMEDF file contains no data records: ${fileName}`)
    return
  }

  const start = parseWmedfStart(content)
  if (!start) {
    collector.warnings.push(`Could not read start date/time of WMEDF file: ${fileName}`)
    return
  }

  const dayDate = start.slice(0, 10)
  const durationSeconds = wmedf.recordCount * wmedf.recordDurationSeconds

  collector.sessions.push({
    id: fileName.split('/').pop() ?? fileName,
    start,
    end: new Date(new Date(start).getTime() + durationSeconds * 1000).toISOString(),
    durationMinutes: durationSeconds / 60,
    machineId: PRISMA_MACHINE_LABEL,
    eventCount: 0,
  })

  addUsageSeconds(collector, dayDate, durationSeconds)
  collectWmedfStatistics(content, wmedf, fileName, dayDate, collector)
  ensureMachineLabel(collector)
}

/** Per-file pressure/leak channel statistics, folded into per-day aggregates. */
function collectWmedfStatistics(
  content: Uint8Array,
  wmedf: WmedfFile,
  fileName: string,
  dayDate: string | null,
  collector: PrismaCollector
): void {
  if (wmedf.recordCount <= 0 || !dayDate) return

  const pressure = decodeWmedfChannel(content, wmedf, 'Pressure')
  const leak = decodeWmedfChannel(content, wmedf, 'LeakFlowBreath')

  if (pressure && pressure.values.length > 0) {
    const p95 = quantile(pressure.values, 0.95)
    if (Number.isFinite(p95)) {
      addToWeighted(collector.pressureP95ByDate, dayDate, p95, wmedf.recordCount)
    }
  } else {
    collector.warnings.push(`No pressure channel readable in ${fileName}.`)
  }

  if (leak && leak.values.length > 0) {
    const median = quantile(leak.values, 0.5)
    if (Number.isFinite(median)) {
      addToWeighted(collector.leakMedianByDate, dayDate, median, wmedf.recordCount)
    }
  } else {
    collector.warnings.push(`No leak channel readable in ${fileName}.`)
  }
}

interface DecodedWmedfChannel {
  unit: string
  values: number[]
}

function decodeWmedfChannel(
  content: Uint8Array,
  wmedf: WmedfFile,
  label: string
): DecodedWmedfChannel | null {
  let signalIndex = -1
  let leadingBytes = 0
  for (let index = 0; index < wmedf.signals.length; index += 1) {
    if (wmedf.signals[index].label === label) {
      signalIndex = index
      break
    }
    leadingBytes += wmedf.signals[index].bytesPerSample * wmedf.signals[index].samplesPerRecord
  }
  if (signalIndex < 0) return null

  const signal = wmedf.signals[signalIndex]
  const values: number[] = []
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength)

  for (let record = 0; record < wmedf.recordCount; record += 1) {
    const recordStart =
      wmedf.headerBytes + record * wmedf.recordBytes + leadingBytes
    for (let sample = 0; sample < signal.samplesPerRecord; sample += 1) {
      const sampleOffset = recordStart + sample * signal.bytesPerSample
      if (sampleOffset + signal.bytesPerSample > view.byteLength) break
      let raw: number
      if (signal.bytesPerSample === 2) {
        raw = view.getInt16(sampleOffset, true)
      } else if (signal.signed) {
        raw = view.getInt8(sampleOffset)
      } else {
        raw = view.getUint8(sampleOffset)
      }
      values.push(raw * signal.gain + signal.offset)
    }
  }

  return { unit: signal.unit, values }
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))
  return sorted[index]
}

function addToWeighted(map: Map<string, Weighted>, key: string, value: number, weight: number): void {
  const bucket = map.get(key) ?? { sum: 0, weight: 0 }
  bucket.sum += value * weight
  bucket.weight += weight
  map.set(key, bucket)
}

function addUsageSeconds(collector: PrismaCollector, date: string, seconds: number): void {
  collector.usageSecondsByDate.set(date, (collector.usageSecondsByDate.get(date) ?? 0) + seconds)
}

function buildPrismaModel(collector: PrismaCollector): SleepDataModel {
  const dates = new Set<string>([
    ...collector.usageSecondsByDate.keys(),
    ...collector.ahiCountByDate.keys(),
  ])

  const daily: DailyMetric[] = [...dates]
    .sort()
    .map((date) => {
      const usageSeconds = collector.usageSecondsByDate.get(date) ?? 0
      const usageHours = usageSeconds / 3600
      const ahiCount = collector.ahiCountByDate.get(date)
      const leakMedian = collector.leakMedianByDate.get(date)
      const pressureP95 = collector.pressureP95ByDate.get(date)
      const weightAvg = (bucket: Weighted | undefined) =>
        bucket && bucket.weight > 0 ? bucket.sum / bucket.weight : null

      return {
        date,
        ahi: usageHours > 0 && ahiCount !== undefined ? ahiCount / usageHours : null,
        usageHours: usageSeconds > 0 ? usageHours : null,
        leakRate: leakMedian ? weightAvg(leakMedian) : null,
        pressure95: pressureP95 ? weightAvg(pressureP95) : null,
      }
    })

  const machineName =
    collector.machineLabel ?? (collector.machineSerial ? `Prisma S/N ${collector.machineSerial}` : PRISMA_MACHINE_LABEL)

  const eventDistribution = [...collector.eventDistribution.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)

  collector.sessions.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))

  if (daily.length === 0 && collector.sessions.length === 0) {
    collector.warnings.push(
      'No usable Weinmann/Löwenstein prisma session data was found in the PDAT payload.'
    )
  }

  const ahiValues = daily.map((day) => day.ahi)
  return {
    format: 'prisma-pdat',
    sourceFiles: Math.max(1, collector.sourceCount),
    daily,
    sessions: collector.sessions,
    machineUsage: collector.sessions.length > 0 ? [{ name: machineName, sessions: collector.sessions.length }] : [],
    eventDistribution,
    stats: {
      totalDays: daily.length,
      avgAhi: averageNumber(ahiValues),
      avgUsageHours: averageNumber(daily.map((day) => day.usageHours)),
      totalSessions: collector.sessions.length,
      totalRespiratoryEvents: eventDistribution.reduce((total, event) => total + event.value, 0),
    },
    warnings: collector.warnings,
  }
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
