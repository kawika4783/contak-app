export type User = { id: string; username: string; display_name: string; email: string; role: 'user' | 'admin' }
export type Contact = { id: string; username: string; display_name: string; favorite?: boolean }
export type ApiAttachment = { url: string; name: string; mime: string; size: number }
export type ApiMessage = { id: string; body: string; created_at: string; sender_id: string; username: string; display_name: string; read?: boolean; attachment?: ApiAttachment | null }
export type ApiConversation = { id: string; created_at: string; participant: Contact; last_message: ApiMessage | null; unread_count: number }

const jsonHeaders = { 'Content-Type': 'application/json' }

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(isFormData ? {} : jsonHeaders), ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.message || `Request failed (${response.status})`)
  return payload as T
}

export function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}
