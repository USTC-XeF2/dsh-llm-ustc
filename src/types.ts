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

export interface TunnelCredential {
  host: string
  port: number
  username: string
  password: string
}

export interface CachedModel {
  id: string
  name: string
}

export interface PluginState {
  models: CachedModel[]
  modelsUpdatedAt?: string
}
