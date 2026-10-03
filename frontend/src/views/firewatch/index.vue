<template>
  <section class="page" data-module="firewatch">
    <header class="page-head">
      <div>
        <h2>火险监测管理</h2>
        <p class="page-desc">维护火险监测点，围绕监测点编号、监测区域、火险等级、风力等级做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记火险监测点</button>
        <button class="btn" type="button" @click="exportRows">导出火险监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="calibration-board">
      <header class="board-head">
        <div>
          <h3>等级校准工作台</h3>
          <p class="page-desc">
            当前标准 {{ STANDARD_VERSION }}：按火险等级、风力等级、相对湿度、气温读数判定建议等级，
            与人工设置冲突时就高取值；历史结论按当时标准保留。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" @click="calibrateAll">全部校准生效</button>
        </div>
      </header>

      <ul class="standard-rules">
        <li v-for="rule in STANDARD_RULES" :key="rule">{{ rule }}</li>
      </ul>

      <p class="board-summary">
        待校准 {{ candidates.length }} 点 · 与人工设置冲突 {{ conflictCount }} 条 · 历史结论 {{ history.length }} 条
        <span v-if="boardMessage" class="board-message">{{ boardMessage }}</span>
      </p>

      <table class="data-table">
        <thead>
          <tr>
            <th>监测点编号</th>
            <th>监测区域</th>
            <th>火险等级</th>
            <th>风力等级</th>
            <th>相对湿度</th>
            <th>气温读数</th>
            <th>人工设置</th>
            <th>建议等级</th>
            <th>生效等级</th>
            <th>判定依据</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in candidates" :key="String(item.row.id)">
            <td>{{ item.row['监测点编号'] }}</td>
            <td>{{ item.row['监测区域'] }}</td>
            <td>{{ item.row['火险等级'] || '—' }}</td>
            <td>
              <span :class="{ 'missing-text': item.evaluation.windMissing }">
                {{ item.row['风力等级'] || '缺失' }}
              </span>
            </td>
            <td>{{ item.row['相对湿度'] || '—' }}</td>
            <td>{{ item.row['气温读数'] || '—' }}</td>
            <td><span class="level-badge" :data-level="item.evaluation.manual">{{ item.evaluation.manual }}</span></td>
            <td><span class="level-badge" :data-level="item.evaluation.suggested">{{ item.evaluation.suggested }}</span></td>
            <td>
              <span class="level-badge" :data-level="item.evaluation.effective">{{ item.evaluation.effective }}</span>
              <span v-if="item.evaluation.conflict" class="conflict-tag">冲突·就高</span>
            </td>
            <td class="basis-cell" :title="item.evaluation.reasons.join('；')">
              {{ item.evaluation.reasons.join('；') }}
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="calibrate(item.row)">校准生效</button>
            </td>
          </tr>
          <tr v-if="!candidates.length">
            <td colspan="11" class="empty-state">暂无待校准的火险监测点</td>
          </tr>
        </tbody>
      </table>

      <h4 class="history-title">校准记录（按当时标准保留）</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>校准编号</th>
            <th>监测点编号</th>
            <th>人工设置</th>
            <th>建议等级</th>
            <th>生效等级</th>
            <th>冲突处理</th>
            <th>标准版本</th>
            <th>校准时间</th>
            <th>结论状态</th>
            <th>判定依据</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in history" :key="String(record.id)">
            <td>{{ record['校准编号'] }}</td>
            <td>{{ record['监测点编号'] }}</td>
            <td>{{ record['人工设置等级'] }}</td>
            <td><span class="level-badge" :data-level="String(record['建议等级'])">{{ record['建议等级'] }}</span></td>
            <td><span class="level-badge" :data-level="String(record['生效等级'])">{{ record['生效等级'] }}</span></td>
            <td>{{ record['冲突处理'] }}</td>
            <td>{{ record['标准版本'] }}</td>
            <td>{{ record['校准时间'] }}</td>
            <td>{{ record.status }}</td>
            <td class="basis-cell" :title="String(record['判定依据'])">{{ record['判定依据'] }}</td>
          </tr>
          <tr v-if="!history.length">
            <td colspan="10" class="empty-state">暂无校准记录，校准生效后在此留痕</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无火险监测数据，可先登记火险监测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条火险监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  applyAllCalibrations,
  applyCalibration,
  listCalibrationCandidates,
  listCalibrationHistory,
} from '@/api/calibration-service'
import type { CalibrationCandidate } from '@/api/calibration-service'
import { STANDARD_RULES, STANDARD_VERSION } from '@/data/calibration'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firewatch')
const columns = ["监测点编号", "监测区域", "火险等级", "风力等级", "相对湿度", "气温读数", "监测时间", "监测状态"]
const actions = ["更新等级", "解除预警", "升级预警"]
const statuses = ["正常", "蓝色预警", "黄色预警", "橙色预警", "红色预警"]
const stats = [{"label": "监测点数", "value": 0}, {"label": "红色预警数", "value": 0}, {"label": "今日新增预警", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const candidates = ref<CalibrationCandidate[]>([])
const history = ref<EntryRow[]>([])
const boardMessage = ref('')
const conflictCount = computed(
  () => candidates.value.filter((item) => item.evaluation.conflict).length,
)

function reloadBoard() {
  candidates.value = listCalibrationCandidates()
  history.value = listCalibrationHistory()
}

function calibrate(row: EntryRow) {
  const result = applyCalibration(Number(row.id))
  boardMessage.value = result.message
  if (result.ok) {
    reload()
    reloadBoard()
  }
}

function calibrateAll() {
  const result = applyAllCalibrations()
  boardMessage.value = result.message
  reload()
  reloadBoard()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '火险监测点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  reloadBoard()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火险监测列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadBoard()
})
</script>
