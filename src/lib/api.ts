export type User = { id: string; username: string; display_name: string; email: string; role: 'user' | 'admin' }
export type Contact = { id: string; username: string; display_name: string; favorite?: boolean }
export type ApiMessage = { id: string; body: string; created_at: string; sender_id: string; username: string; display_name: string; read?: boolean }
export type ApiConversation = { id: string; created_at: string; participant: Contact; last_message: ApiMessage | null; unread_count: number }

const jsonHeaders = { 'Content-Type': 'application/json' }

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...jsonHeaders, ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.message || 'Something went wrong')
  return payload as T
}

export function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}
