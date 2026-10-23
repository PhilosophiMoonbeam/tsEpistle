<template>
  <v-container fluid class="admin-assets">
    <admin-hero title="Assets" description="Manage shared files, folders and resized image copies." icon="mdi-folder-image" />
    <editor-modal-media v-if="canManageSystem" :key="assetOwner" purpose="manage" embedded />
    <v-alert v-else type="warning" variant="tonal" role="alert">
      System management permission is required to open the Assets workspace.
    </v-alert>
  </v-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'
import AdminHero from '../common/admin-hero.vue'
import EditorModalMedia from '../editor/editor-modal-media.vue'

export default defineComponent({
  components: { AdminHero, EditorModalMedia },
  computed: {
    canManageSystem(): boolean {
      return wikiStore.user.authenticated && wikiStore.user.permissions.includes('manage:system')
    },
    assetOwner(): string {
      return JSON.stringify([wikiStore.user.id, wikiStore.offlineIdentityEpoch])
    }
  }
})
</script>
