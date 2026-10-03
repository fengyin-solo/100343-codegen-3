import type { EntryRow } from './types'

// 等级校准标准（STD-2026A）：阈值表版本化管理。
// 历史校准结论按当时版本快照保留，标准调整只影响新结论，不回写历史。
export const STANDARD_VERSION = 'STD-2026A'

export const LEVELS = ['正常', '蓝色预警', '黄色预警', '橙色预警', '红色预警'] as const

export function levelIndex(level: string): number {
  const index = LEVELS.indexOf(level as (typeof LEVELS)[number])
  return index < 0 ? 0 : index
}

// 展示在工作台上的规则说明，与 evaluate() 的判定逻辑一一对应。
export const STANDARD_RULES = [
  '基础档：火险等级一~五级依次映射 正常 / 蓝色 / 黄色 / 橙色 / 红色',
  '风力等级 ≥ 5 级上调一档，≥ 8 级上调两档',
  '相对湿度 ≤ 30% 上调一档，≤ 15% 上调两档',
  '气温读数 ≥ 30℃ 上调一档，≥ 35℃ 上调两档',
  '风力数据缺失时不得判为正常，至少蓝色预警',
  '建议等级与人工设置冲突时就高取值',
]

export type Evaluation = {
  suggested: string
  effective: string
  manual: string
  conflict: boolean
  windMissing: boolean
  reasons: string[]
}

const CN_RISK: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }

// 火险等级接受「1-5」「三级」「较高」等写法，解析不出时按三级起评并在依据里注明。
function parseFireRisk(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const digit = text.match(/[1-5]/)
  if (digit) return Number(digit[0])
  for (const [cn, value] of Object.entries(CN_RISK)) {
    if (text.includes(cn)) return value
  }
  if (text.includes('极高')) return 5
  if (text.includes('高')) return 4
  if (text.includes('中')) return 3
  if (text.includes('较低')) return 2
  if (text.includes('低')) return 1
  return null
}

function parseNumber(raw: string): number | null {
  const text = raw.trim()
  if (!text || text === '—') return null
  const match = text.match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : null
}

// 用 火险等级 / 风力等级 / 相对湿度 / 气温读数 判定建议等级，并就高裁决出生效等级。
export function evaluate(row: EntryRow): Evaluation {
  const reasons: string[] = []

  const riskRaw = String(row['火险等级'] ?? '')
  const risk = parseFireRisk(riskRaw)
  if (risk === null) {
    reasons.push(`火险等级「${riskRaw || '空'}」无法解析，按三级起评`)
  } else {
    reasons.push(`火险等级${risk}级，基础档「${LEVELS[risk - 1]}」`)
  }
  let score = risk === null ? 2 : risk - 1

  const wind = parseNumber(String(row['风力等级'] ?? ''))
  const windMissing = wind === null
  if (windMissing) {
    reasons.push('风力数据缺失，不参与上调')
  } else if (wind >= 8) {
    score += 2
    reasons.push(`风力${wind}级 ≥ 8级，上调两档`)
  } else if (wind >= 5) {
    score += 1
    reasons.push(`风力${wind}级 ≥ 5级，上调一档`)
  } else {
    reasons.push(`风力${wind}级，不上调`)
  }

  const humidity = parseNumber(String(row['相对湿度'] ?? ''))
  if (humidity !== null) {
    if (humidity <= 15) {
      score += 2
      reasons.push(`相对湿度${humidity}% ≤ 15%，上调两档`)
    } else if (humidity <= 30) {
      score += 1
      reasons.push(`相对湿度${humidity}% ≤ 30%，上调一档`)
    } else {
      reasons.push(`相对湿度${humidity}%，不上调`)
    }
  }

  const temp = parseNumber(String(row['气温读数'] ?? ''))
  if (temp !== null) {
    if (temp >= 35) {
      score += 2
      reasons.push(`气温${temp}℃ ≥ 35℃，上调两档`)
    } else if (temp >= 30) {
      score += 1
      reasons.push(`气温${temp}℃ ≥ 30℃，上调一档`)
    } else {
      reasons.push(`气温${temp}℃，不上调`)
    }
  }

  let index = Math.min(score, LEVELS.length - 1)
  // 保守原则：风力数据缺失时不允许降级到正常。
  if (windMissing && index === 0) {
    index = 1
    reasons.push('风力数据缺失，按保守原则不得判为正常，至少蓝色预警')
  }

  const suggested = LEVELS[index]
  const manual = String(row.status ?? '正常')
  // 冲突裁决：就高取值——建议偏高说明读数恶化必须上调，人工偏高往往掌握现场信息不擅自调低。
  const effective = LEVELS[Math.max(index, levelIndex(manual))]
  const conflict = suggested !== manual
  if (conflict) {
    reasons.push(`建议「${suggested}」与人工设置「${manual}」冲突，就高取「${effective}」`)
  }

  return { suggested, effective, manual, conflict, windMissing, reasons }
}
