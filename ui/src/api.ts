import type {
  PaymentPolicy,
  PaymentResult,
  Preparation,
  Receipt,
  Service,
  Status,
  WalletStatus,
} from './types.ts'

function bridge() {
  if (!window.ryu?.app?.request) {
    throw new Error('This Ryu build does not provide the app HTTP bridge.')
  }
  return window.ryu.app
}

function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  return bridge().request({ method, path, ...(body === undefined ? {} : { body }) }) as Promise<T>
}

export const getStatus = (): Promise<Status> => request('GET', '/status')
export const createWallet = async (): Promise<WalletStatus> =>
  (await request<{ wallet: WalletStatus }>('POST', '/wallet/create', {})).wallet
export const fundWallet = async (): Promise<WalletStatus> =>
  (await request<{ wallet: WalletStatus }>('POST', '/wallet/fund', {})).wallet
export const savePolicy = async (policy: PaymentPolicy): Promise<PaymentPolicy> =>
  (await request<{ policy: PaymentPolicy }>('PUT', '/policy', policy)).policy
export const listServices = async (): Promise<Service[]> =>
  (await request<{ services: Service[] }>('GET', '/services')).services
export const listReceipts = async (): Promise<Receipt[]> =>
  (await request<{ receipts: Receipt[] }>('GET', '/receipts')).receipts
export const preparePayment = (input: {
  method: string
  url: string
}): Promise<Preparation> => request('POST', '/payments/prepare', input)
export const prepareMcpPayment = (input: {
  arguments: Record<string, unknown>
  tool: string
  url: string
}): Promise<Preparation> => request('POST', '/payments/prepare-mcp', input)
export const pay = (approvalToken: string): Promise<PaymentResult> =>
  request('POST', '/payments/pay', { approvalToken })
