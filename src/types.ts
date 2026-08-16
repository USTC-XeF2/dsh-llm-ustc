export interface IwanServer {
  id: string
  name: string
  host: string
  port: number
  username: string
  passWord: string
}

export interface IwanConfig {
  domain: string
  servers: IwanServer[]
}

export interface PublicServer {
  id: string
  name: string
  endpoint: string
}

export interface CachedModel {
  id: string
  name: string
}

export interface PluginState {
  models: CachedModel[]
  modelsUpdatedAt?: string
}

export interface HelperStatus {
  protocol: 'v1'
  target: 'api.llm.ustc.edu.cn:443'
  route: 'direct' | 'iwan'
  iwanConfigured: boolean
  selectedServerId?: string
  tunnelRunning: boolean
}
