import { createGovernedFetch } from './network.ts'
import { AppError, type PaymentPolicy, type ServiceCatalogItem } from './types.ts'

const CATALOG_URL = 'https://mpp.dev/api/services'
const CACHE_TTL_MS = 5 * 60_000
const CATALOG_POLICY: PaymentPolicy = {
  allowedOrigins: ['https://mpp.dev'],
  approvalThresholdAtomic: '0',
  autoPay: false,
  dailySpendCapAtomic: '0',
  enabledMethods: ['tempo'],
  maxPerRequestAtomic: '0',
  testnetOnly: true,
  version: 1,
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function parseEndpoint(value: unknown): ServiceCatalogItem['endpoints'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const endpoint = value as Record<string, unknown>
  const method = text(endpoint.method).toUpperCase()
  const path = text(endpoint.path, text(endpoint.url))
  if (!method || !path) return null
  const price = text(endpoint.price, text(endpoint.amount))
  return { method, path, ...(price ? { price } : {}) }
}

function parseService(value: unknown, index: number): ServiceCatalogItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const service = value as Record<string, unknown>
  const url = text(service.url, text(service.baseUrl, text(service.endpoint)))
  if (!url) return null
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return null
  }
  if (parsedUrl.protocol !== 'https:') return null
  const name = text(service.name, text(service.title, parsedUrl.hostname))
  const rawEndpoints = Array.isArray(service.endpoints) ? service.endpoints : []
  const rawCategories = Array.isArray(service.categories)
    ? service.categories
    : Array.isArray(service.tags)
      ? service.tags
      : []
  return {
    categories: rawCategories.filter((item): item is string => typeof item === 'string').slice(0, 12),
    description: text(service.description),
    endpoints: rawEndpoints.map(parseEndpoint).filter((item): item is NonNullable<typeof item> => item !== null).slice(0, 30),
    id: text(service.id, `${parsedUrl.hostname}-${index}`),
    name,
    ...(typeof service.status === 'string' ? { status: service.status } : {}),
    url: parsedUrl.toString(),
  }
}

export class MppServiceCatalog {
  readonly #fetch = createGovernedFetch(() => CATALOG_POLICY)
  #cached: { at: number; services: ServiceCatalogItem[] } | null = null

  async list(force = false): Promise<{ cached: boolean; services: ServiceCatalogItem[] }> {
    if (!force && this.#cached && Date.now() - this.#cached.at < CACHE_TTL_MS) {
      return { cached: true, services: this.#cached.services }
    }
    let response: Response
    try {
      response = await this.#fetch(CATALOG_URL, {
        headers: { accept: 'application/json' },
      })
    } catch (error) {
      if (this.#cached) return { cached: true, services: this.#cached.services }
      throw error
    }
    if (!response.ok) {
      if (this.#cached) return { cached: true, services: this.#cached.services }
      throw new AppError('catalog_unavailable', 'MPP service catalog is unavailable.', 502)
    }
    const payload: unknown = await response.json()
    const records = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { services?: unknown }).services)
        ? (payload as { services: unknown[] }).services
        : []
    const services = records
      .map(parseService)
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, 500)
    this.#cached = { at: Date.now(), services }
    return { cached: false, services }
  }
}
