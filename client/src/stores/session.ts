import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { canManageHistory, type Role, type UserInfo } from '../../../shared/protocol'
import type { ConnStatus } from '@/ws/wsClient'

/** 会话状态：连接、身份、在线用户、远程光标 */
export const useSessionStore = defineStore('session', () => {
  const joined = ref(false)
  const docId = ref('demo')
  const name = ref('')
  const role = ref<Role>('editor')
  const clientId = ref('')
  const users = ref<UserInfo[]>([])
  const cursors = ref<Record<string, { start: number; end: number }>>({})
  const status = ref<ConnStatus>('offline')
  const reconnectAttempt = ref(0)
  /** 用户手动模拟断网 */
  const simulatedOffline = ref(false)
  /**
   * 文档正被管理员恢复到历史版本：收到 restore:begin 到全量快照到达之间为 true。
   * 期间编辑器只读、暂停一切本地提交。
   */
  const restoring = ref(false)
  /** 最近一次恢复的提示信息（全量快照到达后用于提示） */
  const restoredNotice = ref('')

  const canEdit = computed(() => role.value === 'editor' || role.value === 'admin')
  const canAnnotate = computed(
    () => role.value === 'editor' || role.value === 'commenter' || role.value === 'admin',
  )
  const canManage = computed(() => canManageHistory(role.value))
  const online = computed(() => status.value === 'online')
  /** 恢复冻结期间编辑者也临时只读，避免基于过期版本提交 */
  const editorReadonly = computed(() => !canEdit.value || restoring.value)

  function setUsers(list: UserInfo[]) {
    users.value = list
    // 清理已离开用户的光标
    const ids = new Set(list.map((u) => u.clientId))
    for (const id of Object.keys(cursors.value)) {
      if (!ids.has(id)) delete cursors.value[id]
    }
  }

  function $reset() {
    joined.value = false
    clientId.value = ''
    users.value = []
    cursors.value = {}
    status.value = 'offline'
    reconnectAttempt.value = 0
    simulatedOffline.value = false
    restoring.value = false
    restoredNotice.value = ''
  }

  return {
    joined,
    docId,
    name,
    role,
    clientId,
    users,
    cursors,
    status,
    reconnectAttempt,
    simulatedOffline,
    restoring,
    restoredNotice,
    canEdit,
    canAnnotate,
    canManage,
    online,
    editorReadonly,
    setUsers,
    $reset,
  }
})
