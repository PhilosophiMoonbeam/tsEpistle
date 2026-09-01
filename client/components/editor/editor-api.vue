<template lang='pug'>
  .editor-api
    .editor-api-main
      v-list.editor-api-sidebar.radius-0(nav, :class='$vuetify.theme.current.dark ? `bg-grey-darken-4` : `bg-primary`')
        v-list-item.animated.fadeInLeft(value='info', :active='tab === `info`', @click='tab = `info`')
          template(v-slot:prepend): v-icon mdi-book-information-variant
          v-list-item-title Info
        v-list-item.mt-3.animated.fadeInLeft.wait-p2s(value='servers', :active='tab === `servers`', @click='tab = `servers`')
          template(v-slot:prepend): v-icon mdi-server
          v-list-item-title Servers
        v-list-item.mt-3.animated.fadeInLeft.wait-p3s(value='endpoints', :active='tab === `endpoints`', @click='tab = `endpoints`')
          template(v-slot:prepend): v-icon mdi-code-braces
          v-list-item-title Endpoints
        v-list-item.mt-3.animated.fadeInLeft.wait-p4s(value='models', disabled)
          template(v-slot:prepend): v-icon mdi-buffer
          v-list-item-title Models
          v-list-item-subtitle Unavailable
        v-list-item.mt-3.animated.fadeInLeft.wait-p5s(value='auth', disabled)
          template(v-slot:prepend): v-icon mdi-lock
          v-list-item-title Authentication
          v-list-item-subtitle Unavailable
      .editor-api-editor
        v-alert.mx-3.mt-3(v-if='parseError', type='error', variant='tonal', density='compact', role='alert') {{parseError}}
        template(v-if='tab === `info`')
          v-container.px-2.pt-1(fluid)
            v-row(density="compact")
              v-col(cols='12')
                .pa-3
                  .text-label-large API General Information
                  .text-body-small.text-grey-darken-1 Global metadata about the API
              v-col(cols='12', lg='6')
                v-card.pt-2
                  v-card-text
                    v-text-field(
                      label='Title'
                      variant="outlined"
                      hint='Required - Title of the API'
                      persistent-hint
                      v-model='info.title'
                    )
                    v-divider.mt-2.mb-4
                    v-text-field(
                      label='Version'
                      variant="outlined"
                      hint='Required - Semantic versioning like 1.0.0 or an arbitrary string like 0.99-beta.'
                      persistent-hint
                      v-model='info.version'
                    )
                    v-divider.mt-2.mb-4
                    v-textarea(
                      label='Description'
                      variant="outlined"
                      hint='Optional - Markdown formatting is supported.'
                      persistent-hint
                      v-model='info.description'
                    )
              v-col(cols='12', lg='6')
                v-card.pt-2
                  v-card-text
                    v-list(nav, lines="two")
                      v-list-item(value='rest', :active='kind === `rest`', @click='kind = `rest`')
                        template(v-slot:prepend)
                          v-avatar
                            img(src='/_assets/svg/icon-transaction-list.svg', alt='REST')
                        v-list-item-title REST API
                        v-list-item-subtitle Classic REST Endpoints
                        template(v-slot:append)
                          v-avatar
                            v-icon(:color='kind === `rest` ? `primary` : `grey-lighten-3`') mdi-check-circle
        template(v-else-if='tab === `servers`')
          v-container.px-2.pt-1(fluid)
            v-row(density="compact")
              v-col(cols='12')
                .pa-3
                  .d-flex.flex-wrap.align-center.justify-space-between.ga-2
                    div
                      .text-label-large List of servers / load balancers where this API reside
                      .text-body-small.text-medium-emphasis Enter all environments, e.g. Integration, QA, Pre-production, Production, etc.
                    v-btn(color='primary', size="large", @click='addServer')
                      v-icon(start) mdi-plus
                      span Add Server
                  v-alert.mt-3(v-if='servers.length === 0', type='info', variant='tonal', density='compact') No servers yet. Use Add Server to describe an environment.
              v-col(cols='12', lg='6', v-for='srv of servers', :key='srv.id')
                v-card.pt-1
                  v-card-text
                    .d-flex
                      .d-flex.flex-column.justify-space-between
                        v-menu(min-width='200')
                          template(v-slot:activator='{ props }')
                            v-btn(variant="text", size="x-large", style='min-width: 0;', v-bind='props')
                              v-icon(size="large", :color='iconColor(srv.icon)') {{iconKey(srv.icon)}}
                          v-list(nav, density="compact")
                            v-list-item(
                              v-for='(srvType, srvKey) in serverTypes'
                              :key='srvKey'
                              :value='srvKey'
                              :active='srv.icon === srvKey'
                              @click='srv.icon = srvKey'
                            )
                              template(v-slot:prepend): v-icon(size="large", :color='srvType.color') {{ srvType.icon }}
                              v-list-item-title {{ srvType.title }}
                        v-btn.mb-2(variant="flat", size="small", @click='removeServer(srv.id)')
                          v-icon(start) mdi-close
                          span Delete
                      v-divider.ml-5(vertical)
                      .pl-5(style='flex: 1 1 100%;')
                        v-text-field(
                          label='Environment / Server Name'
                          variant="outlined"
                          hint='Required - Name of the environment (e.g. QA, Production)'
                          persistent-hint
                          v-model='srv.name'
                        )
                        v-text-field.mt-4(
                          label='URL'
                          variant="outlined"
                          hint='Required - URL of the environment (e.g. https://api.example.com/v1)'
                          persistent-hint
                          v-model='srv.url'
                        )

        template(v-else-if='tab === `endpoints`')
          v-container.px-2.pt-1(fluid)
            v-row(density="compact")
              v-col(cols='12')
                .pa-3
                  .d-flex.flex-wrap.align-center.justify-space-between.ga-2
                    div
                      .text-label-large List of endpoints
                      .text-body-small.text-medium-emphasis Groups of REST endpoints (GET, POST, PUT, DELETE).
                    v-btn(color='primary', size="large", @click='addGroup')
                      v-icon(start) mdi-plus
                      span Add Group
                  v-alert.mt-3(v-if='endpointGroups.length === 0', type='info', variant='tonal', density='compact') No endpoint groups yet. Use Add Group to start documenting endpoints.
              v-col(cols='12', v-for='grp of endpointGroups', :key='grp.id')
                v-card(color="grey-darken-2")
                  v-card-text
                    v-toolbar.editor-api-group-toolbar(color="grey-darken-2", flat, height='auto')
                      .editor-api-group-fields
                        v-text-field.mr-1(
                          flat
                          label='Group Name'
                          variant="solo"
                          hint='Group Name'
                          persistent-hint
                          v-model='grp.name'
                        )
                        v-text-field.mx-1(
                          flat
                          label='Group Description'
                          variant="solo"
                          hint='Group Description'
                          persistent-hint
                          v-model='grp.description'
                        )
                      .editor-api-group-actions
                        v-btn(color="grey-lighten-2", @click='removeGroup(grp.id)', variant="text", height='48')
                          v-icon(start) mdi-trash-can
                          span Delete
                        v-btn(color='pink', @click='addEndpoint(grp)', variant="flat", height='48')
                          v-icon(start) mdi-plus
                          span Add Endpoint
                    v-container.pa-0.mt-2(fluid)
                      v-alert(v-if='grp.endpoints.length === 0', type='info', variant='tonal', density='compact') No endpoints in this group yet. Use Add Endpoint to add one.
                      v-row(density="compact")
                        v-col(cols='12', v-for='ept of grp.endpoints', :key='ept.id')
                          v-card.pt-1
                            v-card-text
                              .d-flex.editor-api-endpoint
                                .d-flex.flex-column.editor-api-endpoint-actions
                                  v-menu(min-width='140')
                                    template(v-slot:activator='{ props }')
                                      v-btn.text-body-large(variant="flat", size="large", style='min-width: 140px;', v-bind='props', :aria-label='`HTTP method ${ept.method}`', :color='methodColor(ept.method)')
                                        strong {{ept.method}}
                                    v-list(nav, density="compact")
                                      v-list-item(:value='mtd.key', :active='ept.method === mtd.key', @click='ept.method = mtd.key', v-for='mtd of endpointMethods', :key='mtd.key')
                                        v-chip.text-center(label, :color='mtd.color') {{mtd.key}}
                                  v-btn.mt-2(v-if='!ept.expanded', size="small", @click='ept.expanded = true', color='pink', variant="outlined")
                                    v-icon(start) mdi-arrow-down-box
                                    span Expand
                                  v-btn.mt-2(v-else, size="small", @click='ept.expanded = false', color='pink', variant="outlined")
                                    v-icon(start) mdi-arrow-up-box
                                    span Collapse
                                  template(v-if='ept.expanded')
                                    v-spacer
                                    v-btn.my-2(variant="flat", size="small", @click='removeEndpoint(grp, ept.id)')
                                      v-icon(start) mdi-close
                                      span Delete
                                v-divider.ml-5(vertical)
                                .pl-5.editor-api-endpoint-fields
                                  .d-flex.editor-api-endpoint-inputs
                                    v-text-field.mr-2(
                                      label='Path'
                                      variant="outlined"
                                      hint='Required - Path to the endpoint (e.g. /planets/{planetId})'
                                      persistent-hint
                                      v-model='ept.path'
                                    )
                                    v-text-field.ml-2(
                                      label='Summary'
                                      variant="outlined"
                                      hint='Required - A short summary of the endpoint (a few words).'
                                      persistent-hint
                                      v-model='ept.summary'
                                    )
                                  template(v-if='ept.expanded')
                                    v-text-field.mt-3(
                                      label='Description'
                                      variant="outlined"
                                      v-model='ept.description'
                                    )

    v-system-bar.editor-status-bar.editor-api-sysbar(absolute, color="grey-darken-3")
      .text-body-small.editor-api-sysbar-locale {{locale.toUpperCase()}}
      .editor-status-path(title='/' + path) /{{path}}
      template(v-if='$vuetify.display.mdAndUp')
        v-spacer
        .text-body-small API Docs
        v-spacer
        .text-body-small OpenAPI 3.0

</template>
<script lang='ts'>
import { defineComponent } from 'vue'
import { wikiStore } from '@/store/index.ts'

type ApiServer = {
  id: string
  name: string
  url: string
  icon: string
}

type ApiServerType = {
  color: string
  icon: string
  title: string
}

type ApiEndpoint = {
  id: string
  method: string
  path: string
  summary: string
  description: string
  expanded: boolean
}

type ApiEndpointGroup = {
  id: string
  name: string
  description: string
  endpoints: ApiEndpoint[]
}

type ApiEndpointMethod = {
  key: string
  color: string
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeEditorServer (value: unknown, index: number): ApiServer | null {
  if (!isRecord(value)) return null
  return {
    id: crypto.randomUUID(),
    name: typeof value.name === 'string' ? value.name : `Server ${index + 1}`,
    url: typeof value.url === 'string' ? value.url : '',
    icon: typeof value.icon === 'string' ? value.icon : 'server'
  }
}

function normalizeEditorGroup (value: unknown): ApiEndpointGroup | null {
  if (!isRecord(value)) return null
  const endpoints = Array.isArray(value.endpoints)
    ? value.endpoints.flatMap(endpoint => {
      if (!isRecord(endpoint)) return []
      const method = typeof endpoint.method === 'string' ? endpoint.method.toUpperCase() : 'GET'
      return [{
        id: crypto.randomUUID(),
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'GET',
        path: typeof endpoint.path === 'string' ? endpoint.path : '',
        summary: typeof endpoint.summary === 'string' ? endpoint.summary : '',
        description: typeof endpoint.description === 'string' ? endpoint.description : '',
        expanded: endpoint.expanded === true
      }]
    })
    : []
  return {
    id: crypto.randomUUID(),
    name: typeof value.name === 'string' ? value.name : '',
    description: typeof value.description === 'string' ? value.description : '',
    endpoints
  }
}

export default defineComponent({
  data() {
    return {
      tab: `endpoints`,
      kind: 'rest',
      parseError: '',
      isInitializing: true,
      info: {
        title: '',
        version: '1.0.0',
        description: ''
      },
      servers: [
        { name: 'Production', url: 'https://api.example.com/v1', icon: 'server', id: '123456' }
      ] as ApiServer[],
      serverTypes: {
        aws: {
          color: 'orange',
          icon: 'mdi-aws',
          title: 'AWS'
        },
        azure: {
          color: 'blue-darken-2',
          icon: 'mdi-azure',
          title: 'Azure'
        },
        digitalocean: {
          color: 'blue',
          icon: 'mdi-digital-ocean',
          title: 'DigitalOcean'
        },
        docker: {
          color: 'blue',
          icon: 'mdi-docker',
          title: 'Docker'
        },
        google: {
          color: 'red',
          icon: 'mdi-google',
          title: 'Google'
        },
        kubernetes: {
          color: 'blue-darken-2',
          icon: 'mdi-kubernetes',
          title: 'Kubernetes'
        },
        linux: {
          color: 'grey-darken-3',
          icon: 'mdi-linux',
          title: 'Linux'
        },
        mac: {
          color: 'grey-darken-2',
          icon: 'mdi-apple',
          title: 'Mac'
        },
        server: {
          color: 'grey',
          icon: 'mdi-server',
          title: 'Server'
        },
        windows: {
          color: 'blue-darken-2',
          icon: 'mdi-windows',
          title: 'Windows'
        }
      } as Record<string, ApiServerType>,
      endpointGroups: [
        {
          id: '345678',
          name: '',
          description: '',
          endpoints: [
            {
              method: 'GET',
              path: '/pet',
              summary: '',
              description: '',
              expanded: false,
              id: '234567'
            }
          ]
        }
      ] as ApiEndpointGroup[],
      endpointMethods: [
        { key: 'GET', color: 'blue' },
        { key: 'POST', color: 'green' },
        { key: 'PUT', color: 'orange' },
        { key: 'PATCH', color: 'cyan' },
        { key: 'DELETE', color: 'red' },
        { key: 'HEAD', color: 'deep-purple' },
        { key: 'OPTIONS', color: 'blue-grey' }
      ] as ApiEndpointMethod[]
    }
  },
  computed: {
    locale() {
      return wikiStore.page.locale
    },
    path() {
      return wikiStore.page.path
    },
    mode() {
      return wikiStore.editor.mode
    },
  },
  watch: {
    info: { deep: true, handler() { this.serializeDocument() } },
    servers: { deep: true, handler() { this.serializeDocument() } },
    endpointGroups: { deep: true, handler() { this.serializeDocument() } },
    kind() { this.serializeDocument() }
  },
  methods: {
    iconColor (val: string) {
      return this.serverTypes[val]?.color ?? 'white'
    },
    iconKey (val: string) {
      return this.serverTypes[val]?.icon ?? 'mdi-server'
    },
    methodColor (val: string) {
      return this.endpointMethods.find(method => method.key === val)?.color ?? 'grey'
    },
    addServer () {
      this.servers.push({
        id: crypto.randomUUID(),
        name: 'Production',
        url: 'https://api.example.com/v1',
        icon: 'server'
      })
    },
    removeServer (id: string) {
      this.servers = this.servers.filter(server => server.id !== id)
    },
    addGroup () {
      this.endpointGroups.push({
        id: crypto.randomUUID(),
        name: '',
        description: '',
        endpoints: []
      })
    },
    removeGroup (id: string) {
      this.endpointGroups = this.endpointGroups.filter(group => group.id !== id)
    },
    addEndpoint (grp: ApiEndpointGroup) {
      grp.endpoints.push({
        id: crypto.randomUUID(),
        method: 'GET',
        path: '/pet',
        summary: '',
        description: '',
        expanded: false
      })
    },
    removeEndpoint (grp: ApiEndpointGroup, eptId: string) {
      grp.endpoints = grp.endpoints.filter(endpoint => endpoint.id !== eptId)
    },
    parseDocument (content: string) {
      const parsed: unknown = JSON.parse(content)
      if (!isRecord(parsed)) throw new Error('The API document must be a JSON object.')
      const document = parsed
      if (document.openapi !== undefined && typeof document.openapi !== 'string') throw new Error('The API document has an invalid OpenAPI version.')
      const info = isRecord(document.info) ? document.info : undefined
      if (info) {
        this.info.title = typeof info.title === 'string' ? info.title : ''
        this.info.version = typeof info.version === 'string' ? info.version : '1.0.0'
        this.info.description = typeof info.description === 'string' ? info.description : ''
      }
      const editorData = isRecord(document['x-wiki-editor']) ? document['x-wiki-editor'] : undefined
      if (editorData && Array.isArray(editorData.servers) && Array.isArray(editorData.endpointGroups)) {
        this.kind = editorData.kind === 'graphql' ? 'graphql' : 'rest'
        this.servers = editorData.servers.flatMap((server, index) => {
          const normalized = normalizeEditorServer(server, index)
          return normalized ? [normalized] : []
        })
        this.endpointGroups = editorData.endpointGroups.flatMap(group => {
          const normalized = normalizeEditorGroup(group)
          return normalized ? [normalized] : []
        })
        return
      }
      this.servers = Array.isArray(document.servers)
        ? document.servers.flatMap((server, index) => {
          if (!isRecord(server)) return []
          return [{
            id: crypto.randomUUID(),
            name: typeof server.description === 'string' ? server.description : `Server ${index + 1}`,
            url: typeof server.url === 'string' ? server.url : '',
            icon: 'server'
          }]
        })
        : []
      const groups = new Map<string, ApiEndpointGroup>()
      const paths = isRecord(document.paths) ? document.paths : undefined
      for (const [path, operations] of Object.entries(paths ?? {})) {
        if (!isRecord(operations)) continue
        for (const [method, operation] of Object.entries(operations)) {
          if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue
          if (!isRecord(operation)) continue
          const details = operation
          const groupName = Array.isArray(details.tags) && typeof details.tags[0] === 'string' ? details.tags[0] : 'Default'
          const group = groups.get(groupName) ?? { id: crypto.randomUUID(), name: groupName, description: '', endpoints: [] }
          group.endpoints.push({ id: crypto.randomUUID(), method: method.toUpperCase(), path, summary: typeof details.summary === 'string' ? details.summary : '', description: typeof details.description === 'string' ? details.description : '', expanded: false })
          groups.set(groupName, group)
        }
      }
      this.endpointGroups = [...groups.values()]
    },
    serializeDocument () {
      if (this.isInitializing) return
      const paths: Record<string, Record<string, unknown>> = {}
      for (const group of this.endpointGroups) {
        for (const endpoint of group.endpoints) {
          if (!endpoint.path.trim()) continue
          const method = endpoint.method.toLowerCase()
          paths[endpoint.path] ??= {}
          paths[endpoint.path][method] = {
            summary: endpoint.summary,
            description: endpoint.description,
            ...(group.name ? { tags: [group.name] } : {})
          }
        }
      }
      wikiStore.editor.content = JSON.stringify({
        openapi: '3.0.0',
        info: { ...this.info },
        servers: this.servers.map(server => ({ url: server.url, description: server.name })),
        paths,
        'x-wiki-editor': { kind: this.kind, servers: this.servers, endpointGroups: this.endpointGroups }
      }, null, 2)
    },
  },
  mounted() {
    wikiStore.editor.editorKey = 'api'
    this.isInitializing = true
    if (this.mode === 'create') {
      this.isInitializing = false
      this.serializeDocument()
    } else {
      try {
        this.parseDocument(wikiStore.editor.content)
      } catch (err) {
        this.parseError = err instanceof Error ? `Unable to read API document: ${err.message}` : 'Unable to read API document.'
      }
    }
    this.isInitializing = false
  }
})
</script>

<style lang='scss'>
$editor-height: calc(100dvh - 64px - 24px);
$editor-height-mobile: calc(100dvh - 56px - 16px);

.editor-api {
  &-main {
    display: flex;
    width: 100%;
    min-height: 0;
    flex: 1 1 auto;
    @include until($tablet) {
      flex-direction: column;
    }
  }


  &-editor {
    background-color: darken(mc('grey', '100'), 4.5%);
    flex: 1 1 50%;
    display: block;
    height: $editor-height;
    min-height: 0;
    position: relative;
    overflow-y: auto;
    padding-bottom: 24px;

    @at-root .v-theme--dark & {
      background-color: darken(mc('grey', '900'), 4.5%);
    }

    @include until($tablet) {
      width: 100%;
      height: calc(#{$editor-height-mobile} - 56px);
    }
  }
  &-group-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px;
  }

  &-group-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    flex: 1 1 360px;
    min-width: 0;
  }

  &-group-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
    flex: 0 1 auto;
  }

  &-endpoint {
    min-width: 0;
    &-actions {
      flex: 0 0 auto;
    }
    &-fields {
      flex: 1 1 100%;
      min-width: 0;
    }
    &-inputs {
      min-width: 0;
      > * {
        flex: 1 1 50%;
        min-width: 0;
      }
    }
  }

  @include until($tablet) {
    &-group-fields {
      grid-template-columns: 1fr;
      flex-basis: 100%;
    }
    &-group-actions {
      flex-basis: 100%;
      justify-content: flex-start;
    }
    &-endpoint {
      &-inputs {
        flex-direction: column;
        > * {
          flex-basis: 100%;
          margin-left: 0 !important;
          margin-right: 0 !important;
        }
      }
      .v-divider {
        display: none;
      }
      &-fields {
        padding-left: 0 !important;
        margin-top: 12px;
      }
    }
  }

  .editor-status-path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 12px;
  }


  &-sidebar {
    width: 200px;

    @include until($tablet) {
      display: flex;
      flex: 0 0 56px;
      width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 0;

      .v-list-item {
        flex: 0 0 auto;
        min-width: 120px;
        min-height: 56px;
        margin-top: 0 !important;
      }

    }
  }

  &-sysbar {
    padding-left: 0 !important;

    &-locale {
      background-color: rgba(255,255,255,.25);
      display:inline-flex;
      padding: 0 12px;
      height: 24px;
      width: 63px;
      justify-content: center;
      align-items: center;
    }
  }

}
</style>
