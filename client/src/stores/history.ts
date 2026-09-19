import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { VersionMeta, VersionSnapshot } from '../../../shared/protocol'
import { collab } from '@/collab/collab'

/**
 * 版本历史抽屉状态：时间线、选中预览、加载与恢复操作。
 * 仅 admin 角色可打开（UI 与服务端双重校验）。
 */
export const useHistoryStore = defineStore('history', () => {
  const visible = ref(false)
  const loading = ref(false)
  const restoring = ref(false)
  const currentRevision = ref(0)
  const versions = ref<VersionMeta[]>([])
  const selectedId = ref<string | null>(null)
  const preview = ref<VersionSnapshot | null>(null)
  const previewLoading = ref(false)
  const errorMsg = ref('')

  async function open() {
    visible.value = true
    await refresh()
  }

  function close() {
    visible.value = false
    selectedId.value = null
    preview.value = null
    errorMsg.value = ''
  }

  async function refresh() {
    loading.value = true
    errorMsg.value = ''
    try {
      const resp = await collab.fetchHistory()
      versions.value = resp.versions
      currentRevision.value = resp.currentRevision
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : '加载版本历史失败'
    } finally {
      loading.value = false
    }
  }

  async function select(versionId: string) {
    if (selectedId.value === versionId && preview.value) return
    selectedId.value = versionId
    preview.value = null
    previewLoading.value = true
    try {
      preview.value = await collab.fetchVersion(versionId)
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : '加载版本内容失败'
      selectedId.value = null
    } finally {
      previewLoading.value = false
    }
  }

  /**
   * 发起恢复。成功后服务端广播 restore:begin 并下发全量快照，
   * 本端由 collab 层进入冻结→重同步→解冻；抽屉关闭，列表稍后刷新。
   */
  async function restore(version: VersionMeta) {
    restoring.value = true
    errorMsg.value = ''
    try {
      await collab.restoreVersion(version.id)
      // 全量快照在 restore:ack 之后很快到达，稍候刷新时间线以包含新版本
      setTimeout(() => {
        void refresh()
      }, 600)
      return true
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : '恢复失败'
      return false
    } finally {
      restoring.value = false
    }
  }

  return {
    visible,
    loading,
    restoring,
    currentRevision,
    versions,
    selectedId,
    preview,
    previewLoading,
    errorMsg,
    open,
    close,
    refresh,
    select,
    restore,
  }
})
