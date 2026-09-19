<script setup lang="ts">
import { computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useHistoryStore } from '@/stores/history'
import type { AnnChangeSummary, VersionMeta } from '../../../shared/protocol'

const history = useHistoryStore()

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const sourceTag = (v: VersionMeta) => {
  if (v.source === 'restore') return { type: 'success' as const, text: '恢复版本' }
  if (v.source === 'manual') return { type: 'primary' as const, text: '手动保存' }
  return { type: 'info' as const, text: '自动版本' }
}

const authorsText = (v: VersionMeta) =>
  v.summary.authors.length ? v.summary.authors.map((a) => a.name).join('、') : '—'

/** 批注变化的可读片段（无变化返回空串） */
function annChangeText(c: AnnChangeSummary): string {
  const parts: string[] = []
  if (c.added) parts.push(`新增 ${c.added}`)
  if (c.replied) parts.push(`回复 ${c.replied}`)
  if (c.resolved) parts.push(`解决 ${c.resolved}`)
  if (c.reopened) parts.push(`重开 ${c.reopened}`)
  if (c.deleted) parts.push(`删除 ${c.deleted}`)
  return parts.join(' · ')
}

const selected = computed(() => history.versions.find((v) => v.id === history.selectedId) ?? null)

async function confirmRestore() {
  const v = selected.value
  if (!v || history.restoring) return
  try {
    await ElMessageBox.confirm(
      `确定将文档恢复到「版本 v${v.revision}」吗？\n\n` +
        '· 恢复不会覆盖历史，而是基于该版本创建一个新版本（版本号继续向前）；\n' +
        '· 所有在线协作者将被暂停编辑并自动全量重新同步；\n' +
        '· 恢复点之后未包含在该版本中的内容将从当前正文移除（仍可在历史中找回）。',
      '恢复到历史版本',
      { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const ok = await history.restore(v)
  if (ok) {
    // 全量快照到达时 collab 层会统一提示「已恢复」，这里只需关闭抽屉
    history.close()
  }
}
</script>

<template>
  <el-drawer
    :model-value="history.visible"
    title="版本历史"
    direction="rtl"
    size="72%"
    :before-close="(done: () => void) => { history.close(); done() }"
  >
    <div class="history-layout">
      <!-- 左：时间线 -->
      <div class="history-list">
        <div class="history-list-head">
          <span>当前版本 <b>v{{ history.currentRevision }}</b></span>
          <el-button size="small" text :loading="history.loading" @click="history.refresh()">刷新</el-button>
        </div>
        <el-alert
          v-if="history.errorMsg"
          :title="history.errorMsg"
          type="error"
          :closable="false"
          show-icon
          style="margin-bottom: 8px"
        />
        <div v-loading="history.loading" class="history-scroll">
          <div
            v-for="v in history.versions"
            :key="v.id"
            class="version-item"
            :class="{ active: v.id === history.selectedId }"
            @click="history.select(v.id)"
          >
            <div class="version-row">
              <el-tag size="small" :type="sourceTag(v).type">{{ sourceTag(v).text }}</el-tag>
              <span class="version-rev">v{{ v.revision }}</span>
              <span class="version-time">{{ fmtTime(v.createdAt) }}</span>
            </div>
            <div class="version-meta">操作者：{{ authorsText(v) }}</div>
            <div class="version-diff">
              <span class="ins" v-if="v.summary.inserts">+{{ v.summary.inserts }} 字</span>
              <span class="del" v-if="v.summary.deletes">−{{ v.summary.deletes }} 字</span>
              <span v-if="v.summary.ops">{{ v.summary.ops }} 次编辑</span>
              <span v-if="!v.summary.ops && !annChangeText(v.annotationChanges)">无正文变更</span>
            </div>
            <div class="version-ann" v-if="annChangeText(v.annotationChanges)">
              💬 批注：{{ annChangeText(v.annotationChanges) }}
            </div>
            <div class="version-restore" v-if="v.source === 'restore'">
              ↩ 由 <b>{{ v.restoredBy?.name || '管理员' }}</b> 恢复自历史版本 {{ v.restoredFromId }}
            </div>
            <div class="version-label" v-if="v.label">📌 {{ v.label }}</div>
          </div>
          <el-empty v-if="!history.loading && history.versions.length === 0" description="暂无历史版本" />
        </div>
      </div>

      <!-- 右：版本预览 -->
      <div class="history-preview">
        <template v-if="history.previewLoading">
          <div v-loading="true" class="preview-loading" />
        </template>
        <template v-else-if="history.preview && selected">
          <div class="preview-head">
            <div>
              <el-tag size="small" :type="sourceTag(selected).type">{{ sourceTag(selected).text }}</el-tag>
              <span class="preview-rev">版本 v{{ selected.revision }}</span>
              <span class="version-time">{{ fmtTime(selected.createdAt) }}</span>
            </div>
            <el-button type="primary" :loading="history.restoring" @click="confirmRestore">
              恢复到此版本
            </el-button>
          </div>
          <div class="preview-body">
            <div class="preview-section">
              <div class="preview-section-title">正文（{{ history.preview.doc.length }} 字）</div>
              <pre class="preview-doc">{{ history.preview.doc || '（空文档）' }}</pre>
            </div>
            <div class="preview-section">
              <div class="preview-section-title">
                批注（{{ history.preview.annotations.length }} 条）
              </div>
              <div class="preview-ann-list">
                <div v-for="a in history.preview.annotations" :key="a.id" class="preview-ann">
                  <div class="preview-ann-quote">“{{ a.quote || '（原文已删除）' }}”</div>
                  <div class="preview-ann-text">{{ a.text }}</div>
                  <div class="preview-ann-meta">
                    {{ a.authorName }} · {{ a.resolved ? '已解决' : '未解决' }} · {{ a.replies.length }} 条回复
                  </div>
                </div>
                <el-empty
                  v-if="history.preview.annotations.length === 0"
                  description="该版本无批注"
                  :image-size="60"
                />
              </div>
            </div>
          </div>
        </template>
        <el-empty v-else description="选择左侧版本查看完整内容" />
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.history-layout {
  display: flex;
  height: 100%;
  gap: 12px;
  padding: 0 16px;
}
.history-list {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--el-border-color-lighter);
  padding-right: 12px;
}
.history-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}
.history-scroll {
  flex: 1;
  overflow-y: auto;
  padding-right: 4px;
}
.version-item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.version-item:hover {
  border-color: var(--el-color-primary-light-5);
}
.version-item.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.version-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.version-rev {
  font-weight: 600;
}
.version-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.version-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 6px;
}
.version-diff {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  margin-top: 4px;
}
.version-diff .ins {
  color: var(--el-color-success);
}
.version-diff .del {
  color: var(--el-color-danger);
}
.version-ann {
  font-size: 12px;
  color: var(--el-color-warning-dark-2);
  margin-top: 4px;
}
.version-restore {
  font-size: 12px;
  color: var(--el-color-success-dark-2);
  margin-top: 4px;
}
.version-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
.history-preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.preview-loading {
  flex: 1;
}
.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.preview-rev {
  font-weight: 600;
  margin-left: 8px;
}
.preview-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-right: 4px;
}
.preview-section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--el-text-color-primary);
}
.preview-doc {
  margin: 0;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 12px;
  font-family: var(--el-font-family-monospace, ui-monospace, monospace);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 46vh;
  overflow-y: auto;
}
.preview-ann-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.preview-ann {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 8px 10px;
}
.preview-ann-quote {
  font-size: 12px;
  color: var(--el-color-warning-dark-2);
  border-left: 3px solid var(--el-color-warning-light-5);
  padding-left: 8px;
  margin-bottom: 4px;
}
.preview-ann-text {
  font-size: 13px;
}
.preview-ann-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
