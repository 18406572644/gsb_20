<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import LoginGate from '@/components/LoginGate.vue'
import TopBar from '@/components/TopBar.vue'
import EditorView from '@/components/EditorView.vue'
import AnnotationPanel from '@/components/AnnotationPanel.vue'
import VersionHistory from '@/components/VersionHistory.vue'

const session = useSessionStore()
</script>

<template>
  <LoginGate v-if="!session.joined" />
  <div v-else class="app-shell">
    <TopBar />
    <el-alert
      v-if="session.restoring"
      type="success"
      :closable="false"
      show-icon
      :title="session.restoredNotice || '文档正在恢复到历史版本，已暂停本地编辑，等待全量同步…'"
    />
    <el-alert
      v-else-if="session.status === 'offline'"
      type="warning"
      :closable="false"
      show-icon
      title="当前处于离线状态：本地编辑与批注已暂存，重新连接后自动同步"
    />
    <el-alert
      v-else-if="session.status === 'reconnecting' || session.status === 'connecting'"
      type="info"
      :closable="false"
      show-icon
      :title="`连接已断开，正在重连（第 ${session.reconnectAttempt} 次）…`"
    />
    <div class="app-main">
      <div class="editor-pane">
        <EditorView />
      </div>
      <AnnotationPanel />
    </div>
    <VersionHistory />
  </div>
</template>
