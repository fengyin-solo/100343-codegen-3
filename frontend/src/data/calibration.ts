// 火险等级校准规则：用监测点读数（火险等级、风力等级、相对湿度、气温读数）判定建议等级。
// 规则带版本号，历史校准结论按当时版本保留，规则升级后不回改旧记录。

export const CALIBRATION_RULE_VERSION = 'FW-STD-2026.10'

export const WARNING_LEVELS = ['正常', '蓝色预警', '黄色预警', '橙色预警', '红色预警'] as const
export type WarningLevel = (typeof WARNING_LEVELS)[number]

export function levelRank(level: string): number {
  const index = WARNING_LEVELS.indexOf(level as WarningLevel)
  return index < 0 ? 0 : index
}

export type ReadingSnapshot = {
  火险等级: string
  风力等级: string
  相对湿度: string
  气温读数: string
}

export type SuggestionResult = {
  level: WarningLevel
  score: number
  windMissing: boolean
  detail: string[]
}

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }

/** 火险等级解析成 1~5，认「三级 / 3级 / 高 / 极高」这类写法，解析不出返回 null。 */
export function parseFireDanger(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const cn = text.match(/([一二三四五])\s*级?/)
  if (cn) return CN_NUM[cn[1]]
  const num = text.match(/([1-5])\s*级/)
  if (num) return Number(num[1])
  if (text.includes('极高')) return 5
  if (text.includes('高')) return 4
  if (text.includes('中')) return 3
  if (text.includes('较低') || text.includes('偏低')) return 2
  if (text.includes('低')) return 1
  return null
}

/** 风力等级取读数里的最大数字（「5~6级」按 6 级），空值、占位符都视为缺失。 */
export function parseWindLevel(raw: string): number | null {
  const text = raw.trim()
  if (!text || text === '—' || text === '-' || text.includes('缺失') || text.includes('无数据')) {
    return null
  }
  const matches = text.match(/\d+(\.\d+)?/g)
  if (!matches) return null
  return Math.max(...matches.map(Number))
}

export function parsePercent(raw: string): number | null {
  const match = raw.trim().match(/\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

export function parseTemperature(raw: string): number | null {
  const match = raw.trim().match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

/**
 * 建议等级判定（版本 FW-STD-2026.10）：
 *   火险等级 1~5 级记 0~4 分；风力 ≥6 级 +2、4~5 级 +1；
 *   相对湿度 <30% +2、30~45% +1；气温 ≥35℃ +2、28~34℃ +1。
 *   读数缺失的项按保守值 +1 分（风力除外，见下）。
 *   总分 0~1 正常、2~3 蓝色、4~5 黄色、6~7 橙色、8 分及以上红色。
 * 硬性约束：缺失风力数据时结论不能降级到正常，保底蓝色预警。
 */
export function computeSuggestion(reading: ReadingSnapshot): SuggestionResult {
  const detail: string[] = []
  let score = 0

  const danger = parseFireDanger(reading.火险等级)
  const dangerScore = danger === null ? 1 : danger - 1
  score += dangerScore
  detail.push(danger === null ? `火险等级缺失按二级计：+${dangerScore}` : `火险等级${danger}级：+${dangerScore}`)

  const wind = parseWindLevel(reading.风力等级)
  const windMissing = wind === null
  let windScore = 0
  if (wind !== null) {
    if (wind >= 6) windScore = 2
    else if (wind >= 4) windScore = 1
  }
  score += windScore
  detail.push(windMissing ? '风力等级缺失：+0，且结论不得降为正常' : `风力${wind}级：+${windScore}`)

  const humidity = parsePercent(reading.相对湿度)
  let humidityScore = 1
  if (humidity !== null) {
    if (humidity < 30) humidityScore = 2
    else if (humidity > 45) humidityScore = 0
  }
  score += humidityScore
  detail.push(humidity === null ? `相对湿度缺失按偏干计：+${humidityScore}` : `相对湿度${humidity}%：+${humidityScore}`)

  const temp = parseTemperature(reading.气温读数)
  let tempScore = 1
  if (temp !== null) {
    if (temp >= 35) tempScore = 2
    else if (temp < 28) tempScore = 0
  }
  score += tempScore
  detail.push(temp === null ? `气温读数缺失按偏高计：+${tempScore}` : `气温${temp}℃：+${tempScore}`)

  let level: WarningLevel
  if (score >= 8) level = '红色预警'
  else if (score >= 6) level = '橙色预警'
  else if (score >= 4) level = '黄色预警'
  else if (score >= 2) level = '蓝色预警'
  else level = '正常'

  if (windMissing && level === '正常') {
    level = '蓝色预警'
    detail.push('风力数据缺失，结论不能降级到正常，保底蓝色预警')
  }

  return { level, score, windMissing, detail }
}

export type ConflictResolution = {
  final: WarningLevel
  conflict: boolean
  note: string
}

/**
 * 建议等级与人工设置冲突时的裁决规则：就高不就低，取两者中较高的等级。
 * 火险场景漏报代价远高于误报，任何一方报出更高等级都不能被另一方拉低。
 */
export function resolveFinalLevel(manualLevel: string, suggested: WarningLevel): ConflictResolution {
  const manualRank = levelRank(manualLevel)
  const suggestedRank = levelRank(suggested)
  if (manualRank === suggestedRank) {
    return { final: suggested, conflict: false, note: '建议与人工一致' }
  }
  if (suggestedRank > manualRank) {
    return { final: suggested, conflict: true, note: '冲突就高：采纳建议等级' }
  }
  return { final: WARNING_LEVELS[manualRank], conflict: true, note: '冲突就高：保留人工等级' }
}
