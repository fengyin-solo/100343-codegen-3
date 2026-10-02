import {
  CALIBRATION_RULE_VERSION,
  computeSuggestion,
  levelRank,
  resolveFinalLevel,
  type ReadingSnapshot,
  type SuggestionResult,
  type WarningLevel,
} from '@/data/calibration'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 校准结论历史单独存一份，键名不进 MODULES，运营概览不会把它当业务模块统计。
export const CALIBRATION_HISTORY_KEY = 'firewatch-calibration'

export type CalibrationPlanItem = {
  pointId: number
  监测点编号: string
  监测区域: string
  reading: ReadingSnapshot
  manualLevel: string
  suggestion: SuggestionResult
  finalLevel: WarningLevel
  conflict: boolean
  conflictNote: string
  changed: boolean
}

export type ApplyOutcome = {
  ok: boolean
  message: string
  applied: number
  skipped: number
  patrolTasks: number
}

function snapshotOf(row: EntryRow): ReadingSnapshot {
  return {
    火险等级: String(row['火险等级'] ?? ''),
    风力等级: String(row['风力等级'] ?? ''),
    相对湿度: String(row['相对湿度'] ?? ''),
    气温读数: String(row['气温读数'] ?? ''),
  }
}

function sameReading(row: EntryRow, reading: ReadingSnapshot): boolean {
  // 历史记录里空读数存成「缺失」，比较前先做同样的归一化
  const norm = (value: string) => value || '缺失'
  return (
    String(row['火险等级'] ?? '') === norm(reading.火险等级) &&
    String(row['风力等级'] ?? '') === norm(reading.风力等级) &&
    String(row['相对湿度'] ?? '') === norm(reading.相对湿度) &&
    String(row['气温读数'] ?? '') === norm(reading.气温读数)
  )
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 校准工作台列表：每个监测点一行，高等级结论排在前面，同级按监测点编号稳定排序。 */
export function buildCalibrationPlan(): CalibrationPlanItem[] {
  const items = listRows('firewatch').map((row) => {
    const reading = snapshotOf(row)
    const suggestion = computeSuggestion(reading)
    const manualLevel = String(row.status)
    const resolution = resolveFinalLevel(manualLevel, suggestion.level)
    return {
      pointId: Number(row.id),
      监测点编号: String(row['监测点编号'] ?? ''),
      监测区域: String(row['监测区域'] ?? ''),
      reading,
      manualLevel,
      suggestion,
      finalLevel: resolution.final,
      conflict: resolution.conflict,
      conflictNote: resolution.note,
      changed: resolution.final !== manualLevel,
    }
  })
  return items.sort(
    (a, b) =>
      levelRank(b.finalLevel) - levelRank(a.finalLevel) ||
      a.监测点编号.localeCompare(b.监测点编号),
  )
}

/** 校准结论历史：新结论在前，旧记录原样保留（含当时的标准版本与读数快照）。 */
export function listCalibrationHistory(): EntryRow[] {
  return [...listRows(CALIBRATION_HISTORY_KEY)].sort((a, b) => Number(b.id) - Number(a.id))
}

/**
 * 校准生效：把结论写回监测点、追加一条历史结论、并在巡护模块生成一份核实事项。
 * 并发与重复上报约束：
 *   - 同一监测点编号只保留一条「有效」结论，新结论生效时旧结论标记「已取代」（内容不回改）；
 *   - 读数、结论、标准版本都相同的重复上报直接跳过，不重复生成结论与巡护事项。
 */
export function applyCalibration(pointIds: number[]): ApplyOutcome {
  const plan = buildCalibrationPlan().filter((item) => pointIds.includes(item.pointId))
  if (plan.length === 0) {
    return { ok: false, message: '没有选中需要校准的监测点', applied: 0, skipped: 0, patrolTasks: 0 }
  }

  const firewatchRows = [...listRows('firewatch')]
  const historyRows = [...listRows(CALIBRATION_HISTORY_KEY)]
  const patrolRows = [...listRows('patrol')]

  const now = new Date()
  const stamp = formatDateTime(now)
  const today = formatDate(now)

  let nextHistoryId = historyRows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  let nextPatrolId = patrolRows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1

  let applied = 0
  let skipped = 0

  for (const item of plan) {
    const active = historyRows.find(
      (row) => String(row['监测点编号']) === item.监测点编号 && row.status === '有效',
    )
    if (
      active &&
      String(active['校准结论']) === item.finalLevel &&
      String(active['标准版本']) === CALIBRATION_RULE_VERSION &&
      sameReading(active, item.reading)
    ) {
      skipped += 1
      continue
    }

    for (const row of historyRows) {
      if (String(row['监测点编号']) === item.监测点编号 && row.status === '有效') {
        row.status = '已取代'
        row.pending = false
      }
    }

    const seq = String(nextHistoryId).padStart(4, '0')
    const conclusionCode = `CAL-${seq}`
    const patrolCode = `PATR-VERI-${seq}`

    historyRows.push({
      id: nextHistoryId,
      status: '有效',
      pending: true,
      abnormal: false,
      结论编号: conclusionCode,
      监测点编号: item.监测点编号,
      监测区域: item.监测区域,
      火险等级: item.reading.火险等级 || '缺失',
      风力等级: item.reading.风力等级 || '缺失',
      相对湿度: item.reading.相对湿度 || '缺失',
      气温读数: item.reading.气温读数 || '缺失',
      建议等级: item.suggestion.level,
      人工等级: item.manualLevel,
      校准结论: item.finalLevel,
      判定得分: item.suggestion.score,
      冲突处理: item.conflictNote,
      标准版本: CALIBRATION_RULE_VERSION,
      校准时间: stamp,
      巡护核实单号: patrolCode,
    })
    nextHistoryId += 1

    const index = firewatchRows.findIndex((row) => Number(row.id) === item.pointId)
    if (index >= 0) {
      firewatchRows[index] = {
        ...firewatchRows[index],
        status: item.finalLevel,
        pending: item.finalLevel !== '正常',
        abnormal: false,
      }
    }

    if (!patrolRows.some((row) => String(row['任务编号']) === patrolCode)) {
      patrolRows.push({
        id: nextPatrolId,
        status: '待执行',
        pending: true,
        abnormal: false,
        任务编号: patrolCode,
        巡护区域: item.监测区域,
        巡护路线: `核实${item.监测点编号}校准结论「${item.finalLevel}」（${conclusionCode}）`,
        巡护员: '待指派',
        巡护日期: today,
        巡护时段: '当日',
        发现火情数: '0',
        任务状态: '待执行',
      })
      nextPatrolId += 1
    }

    applied += 1
  }

  saveRows('firewatch', firewatchRows)
  saveRows(CALIBRATION_HISTORY_KEY, historyRows)
  saveRows('patrol', patrolRows)

  const parts = [`已生效 ${applied} 条校准结论，巡护模块同步生成 ${applied} 条核实事项`]
  if (skipped > 0) {
    parts.push(`${skipped} 条重复上报已跳过`)
  }
  return { ok: applied > 0 || skipped > 0, message: parts.join('；'), applied, skipped, patrolTasks: applied }
}
