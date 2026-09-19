<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { collab } from '@/collab/collab'
import { useDocStore } from '@/stores/doc'
import { useSessionStore } from '@/stores/session'
import type { VersionInfo, VersionReason, VersionSnapshot } from '../../../shared/protocol'

const doc = useDocStore()
const session = useSessionStore()

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const versions = ref<VersionInfo[]>([])
const currentVersionId = ref('')
const loading = ref(false)
const busy = ref(false)

const preview = ref<VersionSnapshot | null>(null)
const previewLoading = ref(false)
const previewVisible = ref(false)

const busyDisabled = computed(
  () => !session.online || doc.syncState === 'resyncing' || doc.frozen || busy.value,
)

const REASON_TAG: Record<VersionReason, { type: 'info' | 'primary' | '' | 'warning' | 'success'; text: string }> = {
  init: { type: 'info', text: '初始' },
  manual: { type: 'primary', text: '手动' },
  auto: { type: '', text: '自动' },
  'pre-restore': { type: 'warning', text: '恢复前备份' },
  restored: { type: 'success', text: '已恢复' },
}

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function reload() {
  if (!props.modelValue) return
  loading.value = true
  try {
    const res = await collab.loadHistory()
    versions.value = res.versions
    currentVersionId.value = res.current.versionId
  } catch (e) {
    ElMessage.error((e as Error).message || '加载版本历史失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reload()
  },
)

// 面板打开期间，任何新版本（他人保存 / 自动快照 / 恢复）都实时刷新
const unregister = collab.onHistoryChanged(() => {
  if (props.modelValue) reload()
})
onBeforeUnmount(unregister)

async function saveVersion() {
  let label = ''
  try {
    const r = await ElMessageBox.prompt('为当前版本填写说明（可留空）', '保存版本', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValue: '',
      inputValidator: () => true,
    })
    label = (r.value || '').trim()
  } catch {
    return
  }
  busy.value = true
  try {
    await collab.saveVersion(label || undefined)
    ElMessage.success('版本已保存')
    await reload()
  } catch (e) {
    ElMessage.error((e as Error).message || '保存版本失败')
  } finally {
    busy.value = false
  }
}

async function openPreview(v: VersionInfo) {
  previewLoading.value = true
  previewVisible.value = true
  try {
    const res = await collab.getVersion(v.id)
    preview.value = res.version
  } catch (e) {
    previewVisible.value = false
    ElMessage.error((e as Error).message || '加载版本内容失败')
  } finally {
    previewLoading.value = false
  }
}

async function restore(v: VersionInfo) {
  try {
    await ElMessageBox.confirm(
      `确定恢复到「${v.label || `v${v.revision}`}」吗？\n\n` +
        '· 恢复前会自动备份当前状态；\n' +
        '· 所有在线协作者将暂停编辑并全量重新同步；\n' +
        '· 各端尚未同步的本地修改会被丢弃。',
      '恢复版本',
      { type: 'warning', confirmButtonText: '确认恢复', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  busy.value = true
  try {
    await collab.restoreVersion(v.id)
    ElMessage.success('恢复完成')
    await reload()
  } catch (e) {
    ElMessage.error((e as Error).message || '恢复失败')
  } finally {
    busy.value = false
  }
}

function deltaCount(v: VersionInfo) {
  const d = v.annotationDelta
  return [
    d.added && `批注 +${d.added}`,
    d.removed && `批注 -${d.removed}`,
    d.resolved && `解决 ${d.resolved}`,
    d.replies && `回复 +${d.replies}`,
  ].filter(Boolean)
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    title="版本历史"
    direction="rtl"
    size="420px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="hv-toolbar">
      <el-button size="small" type="primary" plain :disabled="busyDisabled" @click="saveVersion">
        保存当前版本
      </el-button>
      <el-button size="small" text :disabled="busyDisabled" @click="reload">刷新</el-button>
    </div>

    <div v-loading="loading" class="hv-list">
      <div v-if="!loading && versions.length === 0" class="hv-empty">暂无历史版本</div>

      <div v-for="v in versions" :key="v.id" class="hv-card" :class="{ head: v.head }">
        <div class="hv-card-head">
          <span class="hv-label">{{ v.label || `版本 v${v.revision}` }}</span>
          <el-tag size="small" :type="REASON_TAG[v.reason].type" effect="light">
            {{ REASON_TAG[v.reason].text }}
          </el-tag>
          <el-tag v-if="v.head" size="small" type="success" effect="dark">当前</el-tag>
        </div>

        <div class="hv-meta">
          <span>👤 {{ v.authorName }}</span>
          <span>🕒 {{ fmtTime(v.createdAt) }}</span>
          <span class="hv-ver">
            v{{ v.revision }}<template v-if="v.epoch > 0"> · e{{ v.epoch }}</template>
          </span>
        </div>

        <div v-if="v.changes.length" class="hv-changes">
          <div v-for="c in v.changes" :key="c.clientId" class="hv-change-row">
            <span class="hv-author">{{ c.authorName }}</span>
            <span class="hv-stat">
              <template v-if="c.inserted"><b class="ins">+{{ c.inserted }}</b></template>
              <template v-if="c.deleted"><b class="del">−{{ c.deleted }}</b></template>
              <i v-if="!c.inserted && !c.deleted" class="noop">无净增删</i>
              <em>{{ c.ops }} 次操作</em>
            </span>
          </div>
        </div>
        <div v-else-if="v.reason !== 'restored'" class="hv-nochanges">无正文操作</div>

        <div v-if="deltaCount(v).length" class="hv-deltas">
          <el-tag v-for="(t, i) in deltaCount(v)" :key="i" size="small" effect="plain">{{ t }}</el-tag>
        </div>

        <div v-if="v.restoredFrom" class="hv-restored-from">
          ↩ 恢复自 v{{ v.restoredFrom.revision }}
          <template v-if="v.restoredFrom.label">（{{ v.restoredFrom.label }}）</template>
        </div>

        <div class="hv-actions">
          <el-button size="small" text @click="openPreview(v)">预览</el-button>
          <el-button
            size="small"
            text
            type="danger"
            :disabled="busyDisabled || v.head"
            @click="restore(v)"
          >
            恢复到此版本
          </el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="previewVisible" title="版本预览" width="640px" append-to-body destroy-on-close>
      <div v-loading="previewLoading">
        <template v-if="preview">
          <p class="pv-meta">
            {{ preview.label }} · {{ preview.authorName }} · {{ fmtTime(preview.createdAt) }} ·
            v{{ preview.revision }} · {{ preview.annotations.length }} 条批注
          </p>
          <div class="pv-doc">{{ preview.doc }}</div>
          <div v-if="preview.annotations.length" class="pv-anns">
            <h4>批注（{{ preview.annotations.length }}）</h4>
            <div v-for="a in preview.annotations" :key="a.id" class="pv-ann">
              <p class="pv-ann-quote">“{{ a.quote || '（锚点已删除）' }}”</p>
              <p>{{ a.text }}</p>
              <small>
                {{ a.authorName }} · {{ fmtTime(a.createdAt) }}
                <el-tag v-if="a.resolved" size="small" type="success" effect="plain">已解决</el-tag>
              </small>
            </div>
          </div>
        </template>
      </div>
    </el-dialog>
  </el-drawer>
</template>

<style scoped>
:deep(.el-drawer__body) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.hv-toolbar {
  display: flex;
  gap: 8px;
  padding: 0 16px 12px;
}
.hv-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hv-empty {
  color: #909399;
  font-size: 13px;
  text-align: center;
  padding: 40px 0;
}
.hv-card {
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 10px 12px;
}
.hv-card.head {
  border-color: #67c23a55;
  box-shadow: 0 0 0 1px #67c23a22;
}
.hv-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hv-label {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hv-meta {
  display: flex;
  gap: 12px;
  color: #909399;
  font-size: 12px;
  margin-top: 6px;
}
.hv-ver {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.hv-changes {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hv-change-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #606266;
}
.hv-author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
.hv-stat {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.hv-stat .ins {
  color: #67c23a;
}
.hv-stat .del {
  color: #f56c6c;
}
.hv-stat em {
  color: #c0c4cc;
  font-style: normal;
}
.noop {
  color: #c0c4cc;
}
.hv-nochanges {
  margin-top: 6px;
  font-size: 12px;
  color: #c0c4cc;
}
.hv-deltas {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.hv-restored-from {
  margin-top: 6px;
  font-size: 12px;
  color: #e6a23c;
}
.hv-actions {
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}
.pv-meta {
  color: #909399;
  font-size: 12px;
  margin: 0 0 8px;
}
.pv-doc {
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 12px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.7;
  background: #fafafa;
}
.pv-anns h4 {
  margin: 16px 0 8px;
}
.pv-ann {
  border-left: 3px solid #e6a23c;
  padding: 4px 10px;
  margin-bottom: 8px;
  background: #fafafa;
  border-radius: 0 6px 6px 0;
  font-size: 13px;
}
.pv-ann-quote {
  color: #909399;
  margin: 0 0 4px;
}
.pv-ann small {
  color: #909399;
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
