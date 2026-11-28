export type ProfileVisibility = 'private' | 'public'
export type User = { id: string; username: string; display_name: string; email: string; role: 'user' | 'admin'; phone?: string | null; hometown?: string | null; about_me?: string | null; profile_image_url?: string | null; profile_visibility?: ProfileVisibility; search_by_email?: boolean; search_by_phone?: boolean; search_by_name?: boolean; profile_updated_at?: string | null }
export type PresenceStatus = 'online' | 'offline' | 'away' | 'busy' | 'dnd' | 'invisible'
export type Contact = { id: string; username: string; display_name: string; nickname?: string | null; favorite?: boolean; favorite_order?: number; presence?: PresenceStatus; profile_image_url?: string | null }
export type ContactGroup = { id: string; name: string; created_at: string; member_count: number }
export type ApiAttachment = { url?: string | null; name: string; mime: string; size: number; ephemeral?: { state: 'pending' | 'unopened' | 'viewing' | 'opened' | 'expired' | 'revoked' | 'deleted'; durationSeconds: number } }
export type ApiMessage = { id: string; conversation_id: string; body: string; created_at: string; sender_id: string; username: string; display_name: string; read?: boolean; attachment?: ApiAttachment | null }
export type ApiConversation = { id: string; created_at: string; participant: Contact; last_message: ApiMessage | null; unread_count: number }
export type NotificationMode = 'on' | 'silent' | 'off'

const jsonHeaders = { 'Content-Type': 'application/json' }

function notifySessionExpired(message: unknown, hasToken: boolean) {
  if (hasToken && message === 'A valid bearer token is required' && typeof window !== 'undefined') window.dispatchEvent(new Event('contak:session-expired'))
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(isFormData ? {} : jsonHeaders), ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) { notifySessionExpired(payload.message, Boolean(token)); throw new Error(payload.message || `Request failed (${response.status})`) }
  return payload as T
}

function decodeVapidKey(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  return Uint8Array.from([...raw].map(character => character.charCodeAt(0)))
}

export async function syncPushSubscription(token: string, mode: NotificationMode) {
  if (mode === 'off') {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.ready : null
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) {
      await apiRequest('/notifications/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) }, token)
      await subscription.unsubscribe()
    }
    await apiRequest('/notifications/preferences', { method: 'POST', body: JSON.stringify({ mode }) }, token)
    return { permission: 'default' }
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Browser notifications are not supported on this device')
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked in this browser' : 'Notification permission was not granted')
  const config = await apiRequest<{ publicKey: string }>('/notifications/config', {}, token)
  if (!config.publicKey) throw new Error('Push notifications are not configured on the server yet')
  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(config.publicKey) })
  await apiRequest('/notifications/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) }, token)
  await apiRequest('/notifications/preferences', { method: 'POST', body: JSON.stringify({ mode }) }, token)
  return { permission }
}

export function uploadFile<T>(path: string, file: File, token: string, onProgress: (percent: number) => void, fields: Record<string, string> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    Object.entries(fields).forEach(([key, value]) => form.append(key, value))
    const request = new XMLHttpRequest()
    request.open('POST', `/api${path}`)
    request.setRequestHeader('Authorization', `Bearer ${token}`)
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
    })
    request.addEventListener('load', () => {
      let payload = {} as T & { message?: string }
      try { payload = JSON.parse(request.responseText || '{}') as T & { message?: string } } catch { /* proxy errors may return HTML */ }
      if (request.status < 200 || request.status >= 300) { notifySessionExpired(payload.message, true); reject(new Error(payload.message || `Upload failed (${request.status})`)); return }
      onProgress(100); resolve(payload)
    })
    request.addEventListener('error', () => reject(new Error('Upload failed. Check your connection and try again.')))
    request.addEventListener('abort', () => reject(new Error('Upload cancelled.')))
    request.send(form)
  })
}

export function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}
