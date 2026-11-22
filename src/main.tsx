import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Bell, Camera, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, Edit3, FileText,
  Hash, Heart, Image, Inbox, LayoutGrid, Mic, MoreVertical, Paperclip, Phone, Play,
  Plus, Search, Send, Settings, ShieldCheck, Smile, Sparkles, UserRoundPlus, UsersRound,
  Video, Volume2, X, Zap,
} from 'lucide-react'
import { io, type Socket } from 'socket.io-client'
import { apiRequest, formatMessageTime, type ApiMessage, type Contact, type User } from './lib/api'
import './styles.css'

type Chat = { id: string; name: string; handle: string; initials: string; color: string; status: 'online' | 'away' | 'busy' | 'offline'; time: string; preview: string; unread?: number; avatar: string; userId?: string; conversationId?: string }
type Message = { id: string | number; from: 'me' | 'them'; text: string; time: string; read?: boolean; reaction?: string }
type AuthSession = { token: string; user: User }

const chats: Chat[] = [
  { id: 'alex', name: 'Alex Morgan', handle: '@alexm', initials: 'AM', color: '#7c3aed', status: 'online', time: '10:24 AM', preview: 'Alex is typing...', unread: 2, avatar: 'https://i.pravatar.cc/160?img=11' },
  { id: 'priya', name: 'Priya Shah', handle: '@priyashah', initials: 'PS', color: '#06b6d4', status: 'online', time: '9:47 AM', preview: 'Meeting moved to 3 PM', avatar: 'https://i.pravatar.cc/160?img=47' },
  { id: 'jordan', name: 'Jordan Lee', handle: '@jlee', initials: 'JL', color: '#f59e0b', status: 'away', time: 'Yesterday', preview: 'Can you send the draft?', unread: 1, avatar: 'https://i.pravatar.cc/160?img=12' },
  { id: 'team', name: 'Team Sync', handle: '4 members', initials: 'TS', color: '#4338ca', status: 'online', time: 'Yesterday', preview: 'Jordan: Looks good! ✓', avatar: '' },
  { id: 'design', name: 'Design Review', handle: '3 members', initials: 'DR', color: '#0f766e', status: 'offline', time: 'Tue', preview: 'Priya: Added my comments', avatar: '' },
  { id: 'alpha', name: 'Project Alpha', handle: '5 members', initials: 'PA', color: '#be185d', status: 'offline', time: 'Mon', preview: 'Alex: Deploying today ✓✓', avatar: '' },
]

const seedMessages: Record<string, Message[]> = {
  alex: [
    { id: 1, from: 'me', text: 'Hey Alex! Are we still good for the sync today at 11?', time: '10:02 AM', read: true },
    { id: 2, from: 'them', text: 'Yes! 11 works perfectly. I’ve got the latest updates ready to share.', time: '10:06 AM' },
    { id: 3, from: 'me', text: 'Awesome. Can you also send the latest build after the call?', time: '10:12 AM', read: true },
    { id: 4, from: 'them', text: 'Sure thing. I’ll upload it here in a few minutes.', time: '10:18 AM' },
    { id: 5, from: 'them', text: 'build-v1.4.0.zip', time: '10:21 AM' },
    { id: 6, from: 'me', text: 'Got it, thanks! This looks great. 🔥', time: '10:23 AM', read: true, reaction: '❤️ 1' },
  ],
  priya: [
    { id: 1, from: 'them', text: 'Hey! Quick update — the meeting moved to 3 PM.', time: '9:41 AM' },
    { id: 2, from: 'me', text: 'That works for me. I’ll bring the review notes.', time: '9:46 AM', read: true },
  ],
  jordan: [
    { id: 1, from: 'them', text: 'Can you send the draft when you get a chance?', time: 'Yesterday' },
  ],
}

const navItems = [
  { id: 'chats', label: 'Chats', icon: Inbox }, { id: 'calls', label: 'Calls', icon: Phone },
  { id: 'contacts', label: 'Contacts', icon: UsersRound }, { id: 'camera', label: 'Camera', icon: Camera },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function Avatar({ chat, size = 'md' }: { chat: Chat; size?: 'sm' | 'md' | 'lg' }) {
  return <div className={`avatar ${size}`} style={{ '--avatar-color': chat.color } as React.CSSProperties}>
    {chat.avatar ? <img src={chat.avatar} alt="" /> : <span>{chat.initials}</span>}
    <i className={`presence ${chat.status}`} />
  </div>
}

function PulseRings() { return <div className="pulse-rings" aria-hidden="true"><span /><span /><span /></div> }

function RingtonePreview({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const ctxRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<number | null>(null)
  const playTone = () => {
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = ctxRef.current || new AudioCtx(); ctxRef.current = ctx
    const now = ctx.currentTime
    ;[523.25, 659.25, 783.99, 659.25].forEach((frequency, index) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.type = 'sine'; osc.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, now + index * .18); gain.gain.exponentialRampToValueAtTime(.06, now + index * .18 + .025); gain.gain.exponentialRampToValueAtTime(.0001, now + index * .18 + .16)
      osc.connect(gain).connect(ctx.destination); osc.start(now + index * .18); osc.stop(now + index * .18 + .18)
    })
  }
  useEffect(() => { if (active) { playTone(); timerRef.current = window.setInterval(playTone, 1300) } return () => { if (timerRef.current) window.clearInterval(timerRef.current) } }, [active])
  return <button className={`ringtone-preview ${active ? 'playing' : ''}`} onClick={onToggle}>{active ? <Volume2 size={15} /> : <Play size={15} />} {active ? 'Playing Contak Pulse' : 'Preview Contak Pulse'}</button>
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      const payload = mode === 'login' ? { username, password } : { username, displayName, email, password }
      const session = await apiRequest<AuthSession>(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(payload) })
      localStorage.setItem('contak-session', JSON.stringify(session)); onAuthenticated(session)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to connect') } finally { setBusy(false) }
  }
  return <div className="auth-shell"><div className="auth-glow" /><div className="auth-card"><div className="brand auth-brand"><span className="brand-mark" /> <span>Contak<span className="brand-dot">.</span>App</span></div><p className="eyebrow">Private communication</p><h1>{mode === 'login' ? 'Welcome back' : 'Create your space'}</h1><p className="auth-copy">{mode === 'login' ? 'Sign in to pick up where you left off.' : 'Start a secure, beautifully simple conversation space.'}</p><form onSubmit={submit}>{mode === 'register' && <><label>Display name<input value={displayName} onChange={event => setDisplayName(event.target.value)} required minLength={2} /></label><label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required /></label></>}<label>Username<input value={username} onChange={event => setUsername(event.target.value)} required minLength={3} autoComplete="username" /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} required minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>{error && <p className="form-error">{error}</p>}<button className="primary-btn auth-submit" disabled={busy}>{busy ? 'Connecting...' : mode === 'login' ? 'Enter Contak.App' : 'Create account'}<ChevronDown size={16} className="auth-arrow" /></button></form><button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>{mode === 'login' ? 'Need an account? Create one' : 'Already have an account? Sign in'}</button><div className="auth-note"><ShieldCheck size={15} /> Your messages are protected by your private workspace.</div></div></div>
}

function Sidebar({ activeNav, setActiveNav, onLogout, user }: { activeNav: string; setActiveNav: (id: string) => void; onLogout: () => void; user: User }) {
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark" /> <span>Contak<span className="brand-dot">.</span>App</span></div>
    <nav className="primary-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={activeNav === id ? 'active' : ''} onClick={() => setActiveNav(id)}><Icon size={20} /><span>{label}</span>{id === 'calls' && <em>2</em>}</button>)}</nav>
    <div className="sidebar-spacer" />
    <div className="sidebar-mini-card"><Sparkles size={15} /><div><strong>Midnight Glass</strong><span>Everything feels connected.</span></div></div>
    <button className="profile-mini" onClick={onLogout} title="Sign out"><div className="avatar sm"><span>{user.display_name.slice(0, 2).toUpperCase()}</span><i className="presence online" /></div><div><strong>{user.display_name}</strong><span>@{user.username} · Sign out</span></div><MoreVertical size={17} /></button>
  </aside>
}

function ChatList({ chats, selectedId, setSelectedId, onNew }: { chats: Chat[]; selectedId: string; setSelectedId: (id: string) => void; onNew: () => void }) {
  return <section className="chat-list">
    <div className="list-heading"><div><p className="eyebrow">Your space</p><h1>Messages</h1></div><button className="icon-btn" onClick={onNew} aria-label="New message"><Edit3 size={17} /></button></div>
    <div className="search-field"><Search size={16} /><input placeholder="Search chats..." aria-label="Search chats" /></div>
    <div className="chat-list-scroll">{chats.length ? chats.map(chat => <button key={chat.id} className={`chat-row ${selectedId === chat.id ? 'selected' : ''}`} onClick={() => setSelectedId(chat.id)}><Avatar chat={chat} /><span className="chat-row-copy"><strong>{chat.name}</strong><span>{chat.preview}</span></span><span className="chat-row-meta"><time>{chat.time}</time>{chat.unread ? <b>{chat.unread}</b> : <CheckCheck size={14} />}</span></button>) : <div className="list-empty"><UsersRound size={22} /><strong>No conversations yet</strong><span>Open Contacts to find someone and start a private chat.</span></div>}</div>
    <div className="list-footer"><ShieldCheck size={14} /><span>Your conversations are private.</span><CircleHelp size={14} /></div>
  </section>
}

function MessageBubble({ message, chat }: { message: Message; chat: Chat }) {
  return <div className={`message-line ${message.from}`}><div className={`message-bubble ${message.text.startsWith('build-') ? 'file-message' : ''}`}>
    {message.text.startsWith('build-') && <FileText size={21} />}
    <span>{message.text}</span><small>{message.time} {message.from === 'me' && (message.read ? <CheckCheck size={13} /> : <Check size={13} />)}</small>
    {message.reaction && <i className="reaction">{message.reaction}</i>}
  </div></div>
}

function Conversation({ chat, messages, setMessages, onSend, onCall }: { chat: Chat; messages: Message[]; setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>; onSend?: (chat: Chat, text: string) => Promise<void>; onCall: (kind: 'audio' | 'video') => void }) {
  const [draft, setDraft] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, isTyping])
  const send = async () => { const value = draft.trim(); if (!value) return; setDraft(''); setIsTyping(false); if (onSend) { await onSend(chat, value); return }; setMessages(prev => ({ ...prev, [chat.id]: [...(prev[chat.id] || []), { id: Date.now(), from: 'me', text: value, time: 'Now', read: false }] })) }
  return <main className="conversation">
    <header className="conversation-header"><div className="conversation-person"><Avatar chat={chat} /><div><h2>{chat.name}</h2><p><span className="status-dot" /> {chat.status === 'online' ? 'Online' : chat.status === 'away' ? 'Away' : 'Offline'}</p></div></div><div className="conversation-actions"><button onClick={() => onCall('audio')} className="icon-btn" aria-label="Audio call"><Phone size={18} /></button><button onClick={() => onCall('video')} className="icon-btn" aria-label="Video call"><Video size={18} /></button><button className="icon-btn desktop-only" aria-label="Search messages"><Search size={18} /></button><button className="icon-btn" aria-label="More options"><MoreVertical size={18} /></button></div></header>
    <div className="message-scroll"><div className="day-divider"><span>Today</span></div>{messages.map(message => <MessageBubble key={message.id} message={message} chat={chat} />)}{isTyping && <div className="typing-row"><Avatar chat={chat} size="sm" /><div className="typing-bubble"><span /><span /><span /></div><small>{chat.name.split(' ')[0]} is typing...</small></div>}<div ref={endRef} /></div>
    <div className="composer-wrap"><div className="composer"><button className="composer-icon" aria-label="Add attachment"><Plus size={20} /></button><input value={draft} onChange={event => { setDraft(event.target.value); setIsTyping(event.target.value.length > 0) }} onKeyDown={event => { if (event.key === 'Enter') send() }} placeholder={`Message ${chat.name}...`} aria-label={`Message ${chat.name}`} /><button className="composer-icon desktop-only" aria-label="Emoji"><Smile size={19} /></button><button className="composer-icon desktop-only" aria-label="Attach file"><Paperclip size={19} /></button><button className="send-btn" onClick={send} aria-label="Send message"><Send size={18} /></button></div><div className="composer-meta"><span><ShieldCheck size={12} /> Private conversation</span><span>Enter to send</span></div></div>
  </main>
}

function UtilityRail({ chat, onCall }: { chat: Chat; onCall: (kind: 'audio' | 'video') => void }) {
  return <aside className="utility-rail"><div className="rail-profile"><Avatar chat={chat} size="lg" /><h2>{chat.name}</h2><p>{chat.handle}</p><span className="online-label"><i /> {chat.status === 'online' ? 'Online now' : 'Recently active'}</span></div><div className="rail-actions"><button onClick={() => onCall('audio')}><Phone size={17} />Audio call</button><button onClick={() => onCall('video')}><Video size={17} />Video call</button></div><div className="rail-divider" /><div className="rail-section"><div className="rail-section-heading"><span>Shared media</span><button>View all</button></div><div className="media-grid"><div><Image size={16} /></div><div><FileText size={16} /></div><div><Play size={16} /></div></div></div><div className="rail-section privacy-note"><ShieldCheck size={17} /><div><strong>Private by design</strong><span>Only you and {chat.name.split(' ')[0]} can see this conversation.</span></div></div></aside>
}

function CallOverlay({ chat, kind, state, onAccept, onDecline, onCancel }: { chat: Chat; kind: 'audio' | 'video'; state: 'incoming' | 'calling' | 'connected'; onAccept: () => void; onDecline: () => void; onCancel: () => void }) {
  return <div className="call-overlay"><div className="call-glow" /><div className="call-card"><button className="call-close" onClick={state === 'incoming' ? onDecline : onCancel}><X size={18} /></button><p className="call-eyebrow">{state === 'incoming' ? 'Incoming call' : state === 'connected' ? 'Connected' : 'Calling...'}</p><div className="call-avatar-wrap"><PulseRings /><Avatar chat={chat} size="lg" /></div><h2>{chat.name}</h2><span className="call-type">{kind === 'audio' ? <Phone size={15} /> : <Video size={15} />}{state === 'incoming' ? `${kind === 'audio' ? 'Audio' : 'Video'} call` : state === 'connected' ? '00:18' : 'Waiting for answer'}</span>{state !== 'connected' && <RingtonePreview active={true} onToggle={() => undefined} />}<div className="call-controls">{state === 'incoming' ? <><button className="decline" onClick={onDecline}><Phone size={20} />Decline</button><button className="accept" onClick={onAccept}><Phone size={20} />Accept</button></> : state === 'calling' ? <button className="decline" onClick={onCancel}><Phone size={20} />Cancel call</button> : <button className="decline" onClick={onCancel}><Phone size={20} />End call</button>}</div></div></div>
}

function ContactsView({ contacts, searchResults, onSearch, onAdd, onOpen }: { contacts: Contact[]; searchResults: Contact[]; onSearch: (query: string) => void; onAdd: (username: string) => void; onOpen: (contact: Contact) => void }) {
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const runSearch = (value: string) => { setQuery(value); onSearch(value) }
  const add = async (username: string) => { await onAdd(username); setNotice(`Request sent to @${username}`) }
  return <div className="contacts-view"><div className="settings-heading"><p className="eyebrow">Your network</p><h1>Contacts</h1><p>Find people and start private conversations.</p></div><div className="contact-search search-field"><Search size={16} /><input value={query} onChange={event => runSearch(event.target.value)} placeholder="Search by username or name..." /></div>{notice && <p className="contact-notice">{notice}</p>}<section className="contacts-card"><div className="contacts-card-heading"><div><h3>{query ? 'Search results' : 'Your contacts'}</h3><p>{query ? 'People you can invite to your private space.' : 'Contacts you have connected with.'}</p></div><UsersRound size={19} /></div>{(query ? searchResults : contacts).length ? (query ? searchResults : contacts).map(contact => <div className="contact-row" key={contact.id}><div className="contact-avatar">{contact.display_name.slice(0, 2).toUpperCase()}</div><div className="contact-copy"><strong>{contact.display_name}</strong><span>@{contact.username}</span></div>{query ? <button className="primary-btn compact-btn" onClick={() => add(contact.username)}><UserRoundPlus size={15} />Add</button> : <button className="contact-open" onClick={() => onOpen(contact)}>Message <Send size={14} /></button>}</div>) : <div className="contacts-empty"><UsersRound size={25} /><strong>{query ? 'No people found' : 'Your contact list is empty'}</strong><span>{query ? 'Try another name or username.' : 'Search above to send your first contact request.'}</span></div>}</section></div>
}

function SettingsView() {
  const [ringtonePlaying, setRingtonePlaying] = useState(false)
  return <div className="settings-view"><div className="settings-heading"><p className="eyebrow">Control center</p><h1>Settings</h1><p>Shape your Contak.App experience.</p></div><div className="settings-grid"><section className="settings-card"><div className="settings-card-heading"><div className="settings-icon violet"><Bell size={17} /></div><div><h3>Call & notification sounds</h3><p>Make every call feel unmistakably yours.</p></div></div><div className="setting-row"><div><strong>Default ringtone</strong><span>Incoming calls on this device</span></div><RingtonePreview active={ringtonePlaying} onToggle={() => setRingtonePlaying(value => !value)} /></div><div className="setting-row"><div><strong>Vibration</strong><span>Use haptics for incoming calls</span></div><button className="toggle on"><span /></button></div><div className="setting-row"><div><strong>Do Not Disturb</strong><span>Pause notifications until you turn it off</span></div><button className="toggle"><span /></button></div></section><section className="settings-card"><div className="settings-card-heading"><div className="settings-icon blue"><ShieldCheck size={17} /></div><div><h3>Privacy</h3><p>Keep your presence and conversations yours.</p></div></div><div className="setting-row"><div><strong>Show online status</strong><span>Let contacts see when you’re around</span></div><button className="toggle on"><span /></button></div><div className="setting-row"><div><strong>Read receipts</strong><span>Show when you’ve read messages</span></div><button className="toggle on"><span /></button></div></section></div></div>
}

function PlaceholderView({ activeNav }: { activeNav: string }) { const nav = navItems.find(item => item.id === activeNav); const Icon = nav?.icon || LayoutGrid; return <div className="empty-view"><div className="empty-icon"><Icon size={28} /></div><h1>{nav?.label || 'Workspace'}</h1><p>This space is ready for the next phase of your private communication stack.</p><button className="primary-btn"><Zap size={17} />Explore {nav?.label}</button></div> }

function contactToChat(contact: Contact): Chat { return { id: contact.id, userId: contact.id, name: contact.display_name, handle: `@${contact.username}`, initials: contact.display_name.slice(0, 2).toUpperCase(), color: '#7c3aed', status: 'offline', time: 'New', preview: 'Start a private conversation', avatar: '' } }
function apiMessageToMessage(message: ApiMessage, currentUserId: string): Message { return { id: message.id, from: message.sender_id === currentUserId ? 'me' : 'them', text: message.body, time: formatMessageTime(message.created_at), read: message.sender_id === currentUserId } }

function App() {
  const [session, setSession] = useState<AuthSession | null>(() => { try { return JSON.parse(localStorage.getItem('contak-session') || 'null') } catch { return null } })
  const [activeNav, setActiveNav] = useState('chats'); const [selectedId, setSelectedId] = useState(''); const [contacts, setContacts] = useState<Contact[]>([]); const [searchResults, setSearchResults] = useState<Contact[]>([]); const [messages, setMessages] = useState<Record<string, Message[]>>({}); const [conversationIds, setConversationIds] = useState<Record<string, string>>({}); const [call, setCall] = useState<{ kind: 'audio' | 'video'; state: 'incoming' | 'calling' | 'connected' } | null>(null)
  const socketRef = useRef<Socket | null>(null); const conversationIdsRef = useRef<Record<string, string>>({})
  const chatList = useMemo(() => contacts.map(contactToChat), [contacts])
  const selectedChat = useMemo(() => chatList.find(chat => chat.id === selectedId) || chatList[0] || null, [chatList, selectedId])

  useEffect(() => {
    if (!session) return
    apiRequest<Contact[]>('/contacts', {}, session.token).then(value => { setContacts(value); if (!selectedId && value[0]) setSelectedId(value[0].id) }).catch(() => undefined)
    const socket = io({ auth: { token: session.token } }); socketRef.current = socket
    socket.on('message:new', (payload: ApiMessage & { conversation_id?: string }) => { const entry = Object.entries(conversationIdsRef.current).find(([, id]) => id === payload.conversation_id); if (!entry) return; const [chatId] = entry; setMessages(prev => { const next = apiMessageToMessage(payload, session.user.id); return prev[chatId]?.some(message => message.id === next.id) ? prev : { ...prev, [chatId]: [...(prev[chatId] || []), next] } }) })
    const heartbeat = window.setInterval(() => socket.emit('presence:heartbeat'), 30_000)
    return () => { window.clearInterval(heartbeat); socket.disconnect(); socketRef.current = null }
  }, [session])

  useEffect(() => {
    if (!session || !selectedChat?.userId) return
    let cancelled = false
    const load = async () => { try { const conversation = await apiRequest<{ id: string }>(`/conversations/with/${selectedChat.userId}`, { method: 'POST' }, session.token); if (cancelled) return; conversationIdsRef.current = { ...conversationIdsRef.current, [selectedChat.id]: conversation.id }; setConversationIds(prev => ({ ...prev, [selectedChat.id]: conversation.id })); socketRef.current?.emit('conversation:join', conversation.id); const serverMessages = await apiRequest<ApiMessage[]>(`/conversations/${conversation.id}/messages`, {}, session.token); if (!cancelled) setMessages(prev => ({ ...prev, [selectedChat.id]: serverMessages.map(message => apiMessageToMessage(message, session.user.id)) })) } catch { if (!cancelled) setMessages(prev => ({ ...prev, [selectedChat.id]: prev[selectedChat.id] || [] })) } }
    load(); return () => { cancelled = true }
  }, [session, selectedChat?.id])

  if (!session) return <AuthScreen onAuthenticated={setSession} />
  const startCall = (kind: 'audio' | 'video') => setCall({ kind, state: 'calling' })
  const sendMessage = async (chat: Chat, text: string) => { if (!chat.userId) return; let conversationId = conversationIds[chat.id]; if (!conversationId) { const created = await apiRequest<{ id: string }>(`/conversations/with/${chat.userId}`, { method: 'POST' }, session.token); conversationId = created.id; conversationIdsRef.current = { ...conversationIdsRef.current, [chat.id]: created.id }; setConversationIds(prev => ({ ...prev, [chat.id]: created.id })); socketRef.current?.emit('conversation:join', created.id) }; const serverMessage = await apiRequest<ApiMessage>(`/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ body: text }) }, session.token); const next = apiMessageToMessage(serverMessage, session.user.id); setMessages(prev => prev[chat.id]?.some(message => message.id === next.id) ? prev : ({ ...prev, [chat.id]: [...(prev[chat.id] || []), next] })) }
  const searchContacts = (query: string) => { if (!query.trim()) { setSearchResults([]); return }; apiRequest<Contact[]>(`/contacts/search?q=${encodeURIComponent(query)}`, {}, session.token).then(setSearchResults).catch(() => setSearchResults([])) }
  const addContact = async (username: string) => { await apiRequest('/contacts/requests', { method: 'POST', body: JSON.stringify({ username }) }, session.token) }
  const openContact = (contact: Contact) => { setSelectedId(contact.id); setActiveNav('chats') }
  const logout = () => { localStorage.removeItem('contak-session'); setSession(null); socketRef.current?.disconnect() }
  return <div className="app-shell"><Sidebar activeNav={activeNav} setActiveNav={setActiveNav} onLogout={logout} user={session.user} /><div className="mobile-topbar"><div className="brand"><span className="brand-mark" /> <span>Contak<span className="brand-dot">.</span>App</span></div><button className="icon-btn"><Bell size={18} /></button></div>{activeNav === 'chats' && selectedChat ? <><ChatList chats={chatList} selectedId={selectedChat.id} setSelectedId={setSelectedId} onNew={() => setActiveNav('contacts')} /><Conversation chat={selectedChat} messages={messages[selectedChat.id] || []} setMessages={setMessages} onSend={sendMessage} onCall={startCall} /><UtilityRail chat={selectedChat} onCall={startCall} /></> : activeNav === 'contacts' ? <div className="content-view"><ContactsView contacts={contacts} searchResults={searchResults} onSearch={searchContacts} onAdd={addContact} onOpen={openContact} /></div> : activeNav === 'settings' ? <div className="content-view"><SettingsView /></div> : <div className="content-view"><PlaceholderView activeNav={activeNav} /></div>}<div className="mobile-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={activeNav === id ? 'active' : ''} onClick={() => setActiveNav(id)}><Icon size={19} /><span>{label}</span></button>)}</div>{call && selectedChat && <CallOverlay chat={selectedChat} kind={call.kind} state={call.state} onAccept={() => setCall({ ...call, state: 'connected' })} onDecline={() => setCall(null)} onCancel={() => setCall(null)} />}</div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}
