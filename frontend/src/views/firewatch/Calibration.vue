<template>
  <section class="page" data-module="firewatch-calibration">
    <header class="page-head">
      <div>
        <h2>火险等级校准工作台</h2>
        <p class="page-desc">
          按监测点读数判定建议等级，与人工设置冲突时就高不就低；校准生效后自动在巡护模块生成核实事项。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="applyAll">全部校准生效</button>
        <RouterLink class="btn" to="/firewatch">返回火险监测</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="rule-note">
      <p>
        判定标准（{{ ruleVersion }}）：火险等级 1~5 级记 0~4 分；风力 ≥6 级 +2、4~5 级 +1；
        相对湿度 &lt;30% +2、30~45% +1；气温 ≥35℃ +2、28~34℃ +1。
        总分 0~1 正常、2~3 蓝色、4~5 黄色、6~7 橙色、8 分及以上红色。
      </p>
      <p>
        冲突裁决：建议等级与人工设置不一致时就高不就低；缺失风力数据的监测点结论不能降级到正常，保底蓝色预警。
        历史结论按当时标准保留，新结论生效后旧结论标记「已取代」，同一监测点只保留一条有效结论。
      </p>
    </div>

    <h3 class="section-title">待校准监测点（高等级在前）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>监测点编号</th>
          <th>监测区域</th>
          <th>火险等级</th>
          <th>风力等级</th>
          <th>相对湿度</th>
          <th>气温读数</th>
          <th>人工等级</th>
          <th>建议等级</th>
          <th>校准结论</th>
          <th>冲突处理</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in plan" :key="item.pointId">
          <td>{{ item.监测点编号 }}</td>
          <td>{{ item.监测区域 }}</td>
          <td>{{ item.reading.火险等级 || '—' }}</td>
          <td>
            <span v-if="item.suggestion.windMissing" class="missing-text">缺失</span>
            <template v-else>{{ item.reading.风力等级 }}</template>
          </td>
          <td>{{ item.reading.相对湿度 || '—' }}</td>
          <td>{{ item.reading.气温读数 || '—' }}</td>
          <td><span class="level-badge" :class="badgeClass(item.manualLevel)">{{ item.manualLevel }}</span></td>
          <td>
            <span class="level-badge" :class="badgeClass(item.suggestion.level)" :title="item.suggestion.detail.join('；')">
              {{ item.suggestion.level }}（{{ item.suggestion.score }}分）
            </span>
          </td>
          <td><span class="level-badge" :class="badgeClass(item.finalLevel)">{{ item.finalLevel }}</span></td>
          <td>
            <span :class="{ 'conflict-text': item.conflict }">{{ item.conflictNote }}</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="applyOne(item)">校准生效</button>
          </td>
        </tr>
        <tr v-if="!plan.length">
          <td colspan="11" class="empty-state">暂无火险监测点，请先在火险监测模块登记</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">校准结论历史（按当时标准保留）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>结论编号</th>
          <th>监测点编号</th>
          <th>监测区域</th>
          <th>建议等级</th>
          <th>人工等级</th>
          <th>校准结论</th>
          <th>判定得分</th>
          <th>冲突处理</th>
          <th>标准版本</th>
          <th>校准时间</th>
          <th>巡护核实单号</th>
          <th>结论状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in history" :key="String(row.id)">
          <td>{{ row['结论编号'] }}</td>
          <td>{{ row['监测点编号'] }}</td>
          <td>{{ row['监测区域'] }}</td>
          <td>{{ row['建议等级'] }}</td>
          <td>{{ row['人工等级'] }}</td>
          <td>{{ row['校准结论'] }}</td>
          <td>{{ row['判定得分'] }}</td>
          <td>{{ row['冲突处理'] }}</td>
          <td>{{ row['标准版本'] }}</td>
          <td>{{ row['校准时间'] }}</td>
          <td>{{ row['巡护核实单号'] }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!history.length">
          <td colspan="12" class="empty-state">暂无校准结论，点击「校准生效」后在此留档</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ plan.length }} 个监测点待校准 · {{ history.length }} 条历史结论</span>
      <span v-if="message" class="ok-text">{{ message }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  applyCalibration,
  buildCalibrationPlan,
  listCalibrationHistory,
  type CalibrationPlanItem,
} from '@/api/calibration-service'
import { CALIBRATION_RULE_VERSION, levelRank } from '@/data/calibration'
import type { EntryRow } from '@/data/types'

const ruleVersion = CALIBRATION_RULE_VERSION

const plan = ref<CalibrationPlanItem[]>([])
const history = ref<EntryRow[]>([])
const message = ref('')
const errorMessage = ref('')

const stats = computed(() => [
  { label: '待校准监测点', value: plan.value.length },
  { label: '冲突条数', value: plan.value.filter((item) => item.conflict).length },
  { label: '橙红结论数', value: plan.value.filter((item) => levelRank(item.finalLevel) >= 3).length },
  { label: '历史结论数', value: history.value.length },
])

const BADGE_CLASSES = ['level-normal', 'level-blue', 'level-yellow', 'level-orange', 'level-red']

function badgeClass(level: string): string {
  return BADGE_CLASSES[levelRank(level)] ?? 'level-normal'
}

function reload() {
  plan.value = buildCalibrationPlan()
  history.value = listCalibrationHistory()
}

function apply(pointIds: number[]) {
  message.value = ''
  errorMessage.value = ''
  try {
    const outcome = applyCalibration(pointIds)
    if (!outcome.ok) {
      errorMessage.value = outcome.message
      return
    }
    message.value = outcome.message
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '校准生效失败'
  }
}

function applyOne(item: CalibrationPlanItem) {
  apply([item.pointId])
}

function applyAll() {
  apply(plan.value.map((item) => item.pointId))
}

onMounted(reload)
</script>
