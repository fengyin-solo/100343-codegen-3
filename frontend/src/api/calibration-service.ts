import { evaluate, levelIndex, STANDARD_VERSION } from '@/data/calibration'
import type { Evaluation } from '@/data/calibration'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 校准结论单独成一个集合，和模块清单一并落在 localStorage，历史结论只追加不改写。
const CAL_KEY = 'firewatch_calibration'
const FIREWATCH_KEY = 'firewatch'
const PATROL_KEY = 'patrol'

export type CalibrationCandidate = {
  row: EntryRow
  evaluation: Evaluation
}

// 待校准列表：按生效等级降序，高等级监测点排在前面；同级按监测时间倒序。
export function listCalibrationCandidates(): CalibrationCandidate[] {
  return listRows(FIREWATCH_KEY)
    .map((row) => ({ row, evaluation: evaluate(row) }))
    .sort((a, b) => {
      const diff = levelIndex(b.evaluation.effective) - levelIndex(a.evaluation.effective)
      if (diff !== 0) return diff
      return String(b.row['监测时间'] ?? '').localeCompare(String(a.row['监测时间'] ?? ''))
    })
}

// 历史结论按校准时间倒序展示，记录里的标准版本与判定依据是生效当时的快照，不做重算。
export function listCalibrationHistory(): EntryRow[] {
  return [...listRows(CAL_KEY)].sort((a, b) =>
    String(b['校准时间'] ?? '').localeCompare(String(a['校准时间'] ?? '')),
  )
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 四项读数的快照：结论是否还有效只看读数变没变，不看人工状态怎么改。
function readingsSnapshot(row: EntryRow): string {
  return ['火险等级', '风力等级', '相对湿度', '气温读数']
    .map((field) => String(row[field] ?? ''))
    .join('|')
}

function buildRecord(id: number, row: EntryRow, evaluation: Evaluation, status: string, note = ''): EntryRow {
  return {
    id,
    status,
    pending: status === '有效结论',
    abnormal: evaluation.conflict,
    校准编号: `CAL-${String(id).padStart(4, '0')}`,
    监测点编号: String(row['监测点编号'] ?? ''),
    监测区域: String(row['监测区域'] ?? ''),
    人工设置等级: evaluation.manual,
    建议等级: evaluation.suggested,
    生效等级: evaluation.effective,
    冲突处理: evaluation.conflict ? '冲突·就高取值' : '无冲突',
    判定依据: `${note}${evaluation.reasons.join('；')}`,
    读数快照: readingsSnapshot(row),
    标准版本: STANDARD_VERSION,
    校准时间: now(),
  }
}

// 校准生效后在巡护任务里生成一条核实待办；按校准编号幂等，同一结论不重复生成。
function createPatrolTodo(record: EntryRow, patrolRows: EntryRow[]): string {
  const code = `PATR-${record['校准编号']}`
  if (patrolRows.some((row) => row['任务编号'] === code)) {
    return code
  }
  const todo: EntryRow = {
    id: nextId(patrolRows),
    status: '待执行',
    pending: true,
    abnormal: false,
    任务编号: code,
    巡护区域: String(record['监测区域'] ?? ''),
    巡护路线: `核实${record['监测点编号']}校准结论（${record['生效等级']}）`,
    巡护员: '待指派',
    巡护日期: String(record['校准时间']).slice(0, 10),
    巡护时段: '尽快',
    发现火情数: '0',
    任务状态: '待执行',
  }
  saveRows(PATROL_KEY, [...patrolRows, todo])
  return code
}

// 单点校准生效：同一监测点编号只保留一个有效结论，旧结论标记「已覆盖」。
export function applyCalibration(rowId: number): ActionResult {
  const rows = listRows(FIREWATCH_KEY)
  const target = rows.find((row) => Number(row.id) === rowId)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${rowId} 的火险监测点` }
  }
  const evaluation = evaluate(target)
  const pointCode = String(target['监测点编号'] ?? '')
  const history = listRows(CAL_KEY)

  // 读数没变化且当前状态已是生效等级时不重复生效，避免刷出重复结论和重复巡护待办；
  // 人工改过状态（如解除预警）则照常重算，校准结论会把它拉回生效等级。
  const snapshot = readingsSnapshot(target)
  const latest = history
    .filter((item) => item['监测点编号'] === pointCode && item.status === '有效结论')
    .sort((a, b) => Number(b.id) - Number(a.id))[0]
  if (latest && latest['读数快照'] === snapshot && String(target.status) === evaluation.effective) {
    return { ok: false, message: `${pointCode} 读数未变化，结论「${evaluation.effective}」已在生效，无需重复校准` }
  }

  const record = buildRecord(nextId(history), target, evaluation, '有效结论')
  const nextHistory = history.map((item) =>
    item['监测点编号'] === pointCode && item.status === '有效结论'
      ? { ...item, status: '已覆盖', pending: false }
      : item,
  )
  nextHistory.push(record)
  saveRows(CAL_KEY, nextHistory)

  const nextRows = rows.map((row) =>
    Number(row.id) === rowId
      ? {
          ...row,
          status: evaluation.effective,
          监测状态: evaluation.effective,
          pending: evaluation.effective !== '正常',
        }
      : row,
  )
  saveRows(FIREWATCH_KEY, nextRows)

  const todoCode = createPatrolTodo(record, listRows(PATROL_KEY))
  const conflictNote = evaluation.conflict ? '（与人工设置冲突，就高取值）' : ''
  return {
    ok: true,
    message: `校准结论 ${record['校准编号']} 已生效：「${evaluation.effective}」${conflictNote}，已生成巡护核实事项 ${todoCode}`,
  }
}

// 批量生效：多个监测点并发上报时，同一监测点编号只留生效等级最高的一条结论，
// 落选上报写入「已覆盖」记录留痕，不静默丢弃。
export function applyAllCalibrations(): ActionResult {
  const candidates = listCalibrationCandidates()
  if (!candidates.length) {
    return { ok: false, message: '没有待校准的火险监测点' }
  }

  const winners = new Map<string, CalibrationCandidate>()
  const duplicates: CalibrationCandidate[] = []
  for (const candidate of candidates) {
    const key = String(candidate.row['监测点编号'] ?? candidate.row.id)
    const held = winners.get(key)
    if (!held) {
      winners.set(key, candidate)
      continue
    }
    const candidateLevel = levelIndex(candidate.evaluation.effective)
    const heldLevel = levelIndex(held.evaluation.effective)
    const takeNew =
      candidateLevel > heldLevel ||
      (candidateLevel === heldLevel && Number(candidate.row.id) > Number(held.row.id))
    if (takeNew) {
      duplicates.push(held)
      winners.set(key, candidate)
    } else {
      duplicates.push(candidate)
    }
  }

  if (duplicates.length) {
    const history = listRows(CAL_KEY)
    let id = nextId(history)
    const covered = duplicates.map((candidate) =>
      buildRecord(id++, candidate.row, candidate.evaluation, '已覆盖', '并发上报去重：同监测点已保留更高或同等级的结论；'),
    )
    saveRows(CAL_KEY, [...history, ...covered])
  }

  let applied = 0
  let skipped = 0
  for (const candidate of winners.values()) {
    const result = applyCalibration(Number(candidate.row.id))
    if (result.ok) {
      applied += 1
    } else {
      skipped += 1
    }
  }

  const parts = [`已生效 ${applied} 条校准结论`]
  if (skipped) parts.push(`${skipped} 条结论未变化跳过`)
  if (duplicates.length) parts.push(`${duplicates.length} 条并发重复上报已覆盖`)
  return { ok: applied > 0, message: parts.join('，') }
}
