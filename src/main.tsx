import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, ArrowLeft, BarChart3, Bell, Camera, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, Database, Edit3, FileText,
  Hash, Heart, Image, Inbox, LayoutGrid, List, Mic, MicOff, MoreHorizontal, MoreVertical, Paperclip, Phone, Play,
  Download, FlipHorizontal2, Plus, RotateCcw, Search, Send, Settings, Shield, ShieldCheck, Smile, Sparkles, UserCog, UserRoundPlus, UsersRound,
  Video, VideoOff, Volume2, X, Zap,
} from 'lucide-react'
import { io, type Socket } from 'socket.io-client'
import { apiRequest, formatMessageTime, syncPushSubscription, uploadFile, type ApiAttachment, type ApiConversation, type ApiMessage, type Contact, type NotificationMode, type User } from './lib/api'
import './styles.css'

type Chat = { id: string; name: string; handle: string; initials: string; color: string; status: 'online' | 'away' | 'busy' | 'offline'; time: string; preview: string; unread?: number; avatar: string; userId?: string; conversationId?: string }
type Message = { id: string | number; from: 'me' | 'them'; text: string; time: string; read?: boolean; reaction?: string; attachment?: ApiAttachment | null }
type AuthSession = { token: string; user: User }
type ActiveCall = { kind: 'audio' | 'video'; state: 'incoming' | 'calling' | 'connected'; callId: string; peerId: string; conversationId?: string }
type ContactRequest = { id: string; username: string; display_name: string; created_at: string }
type CallHistoryItem = { id: string; kind: 'audio' | 'video'; status: 'calling' | 'answered' | 'ended' | 'missed'; direction: 'incoming' | 'outgoing'; created_at: string; username: string; display_name: string; user_id: string }

const chats: Chat[] = [
  { id: 'alex', name: 'Alex Morgan', handle: '@alexm', initials: 'AM', color: '#7c3aed', status: 'online', time: '10:24 AM', preview: 'Alex is typing...', unread: 2, avatar: '' },
  { id: 'priya', name: 'Priya Shah', handle: '@priyashah', initials: 'PS', color: '#06b6d4', status: 'online', time: '9:47 AM', preview: 'Meeting moved to 3 PM', avatar: '' },
  { id: 'jordan', name: 'Jordan Lee', handle: '@jlee', initials: 'JL', color: '#f59e0b', status: 'away', time: 'Yesterday', preview: 'Can you send the draft?', unread: 1, avatar: '' },
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
  { id: 'contacts', label: 'Contacts', icon: UsersRound }, { id: 'calls', label: 'Calls', icon: Phone },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function Avatar({ chat, size = 'md' }: { chat: Chat; size?: 'sm' | 'md' | 'lg' }) {
  return <div className={`avatar ${size}`} style={{ '--avatar-color': chat.color } as React.CSSProperties}>
    {chat.avatar ? <img src={chat.avatar} alt="" /> : <span>{chat.initials}</span>}
    <i className={`presence ${chat.status}`} />
  </div>
}

function PulseRings() { return <div className="pulse-rings" aria-hidden="true"><span /><span /><span /></div> }

type VideoFilterPipeline = { track: MediaStreamTrack; setFilter: (css: string) => void; dispose: () => void }

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

function Sidebar({ activeNav, setActiveNav, onOpenSettings, user }: { activeNav: string; setActiveNav: (id: string) => void; onOpenSettings: () => void; user: User }) {
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark" /> <span>Contak<span className="brand-dot">.</span>App</span></div>
    <nav className="primary-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={activeNav === id ? 'active' : ''} onClick={() => setActiveNav(id)}><Icon size={20} /><span>{label}</span></button>)}</nav>
    <div className="sidebar-spacer" />
    <div className="sidebar-mini-card"><Sparkles size={15} /><div><strong>Midnight Glass</strong><span>Everything feels connected.</span></div></div>
    <button className="profile-mini" onClick={onOpenSettings} title="Open profile settings"><div className="avatar sm"><span>{user.display_name.slice(0, 2).toUpperCase()}</span><i className="presence online" /></div><div><strong>{user.display_name}</strong><span>@{user.username} · Profile settings</span></div><MoreVertical size={17} /></button>
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

function AttachmentPreview({ message, token }: { message: Message; token: string }) {
  const [source, setSource] = useState('')
  const attachment = message.attachment
  useEffect(() => {
    if (!attachment) return
    let active = true
    let objectUrl = ''
    fetch(attachment.url, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => { if (!response.ok) throw new Error('Attachment unavailable'); return response.blob() })
      .then(blob => { objectUrl = URL.createObjectURL(blob); if (active) setSource(objectUrl) })
      .catch(() => { if (active) setSource('') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [attachment, token])
  if (!attachment) return null
  if (!source) return <div className="attachment-loading"><Paperclip size={16} />Loading {attachment.name}...</div>
  if (attachment.mime.startsWith('image/')) return <img className="attachment-image" src={source} alt={attachment.name} />
  if (attachment.mime.startsWith('video/')) return <video className="attachment-video" src={source} controls preload="metadata" />
  return <a className="attachment-file" href={source} download={attachment.name}><FileText size={20} /><span>{attachment.name}<small>{Math.ceil(attachment.size / 1024)} KB</small></span><Download size={16} /></a>
}

function MessageBubble({ message, token }: { message: Message; token: string }) {
  const attachmentMessage = Boolean(message.attachment)
  return <div className={`message-line ${message.from}`}><div className={`message-bubble ${message.text.startsWith('build-') || attachmentMessage ? 'file-message' : ''}`}>
    {message.attachment ? <AttachmentPreview message={message} token={token} /> : message.text.startsWith('build-') && <FileText size={21} />}
    {!message.attachment && <span>{message.text}</span>}
    {message.attachment && <span className="attachment-caption">{message.text}</span>}
    <small>{message.time} {message.from === 'me' && (message.read ? <CheckCheck size={13} /> : <Check size={13} />)}</small>
    {message.reaction && <i className="reaction">{message.reaction}</i>}
  </div></div>
}

function Conversation({ chat, messages, setMessages, onSend, onUpload, token, onTyping, typing, onCall, onBack }: { chat: Chat; messages: Message[]; setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>; onSend?: (chat: Chat, text: string) => Promise<void>; onUpload?: (chat: Chat, file: File, onProgress: (percent: number) => void) => Promise<void>; token: string; onTyping?: (chat: Chat, typing: boolean) => void; typing: boolean; onCall: (kind: 'audio' | 'video') => void; onBack: () => void }) {
  const [draft, setDraft] = useState('')
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [muted, setMuted] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadName, setUploadName] = useState('')
  const [composerError, setComposerError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const quickEmojis = ['😀', '😂', '😍', '👍', '👏', '🔥', '🎉', '❤️', '🙏', '😎', '🤔', '✅']
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, typing])
  const send = async () => { const value = draft.trim(); if (!value) return; setDraft(''); setComposerError(''); onTyping?.(chat, false); if (onSend) { await onSend(chat, value); return }; setMessages(prev => ({ ...prev, [chat.id]: [...(prev[chat.id] || []), { id: Date.now(), from: 'me', text: value, time: 'Now', read: false }] })) }
  const openPicker = (accept: string) => { if (!fileInputRef.current) return; fileInputRef.current.accept = accept; fileInputRef.current.click(); setAttachmentMenuOpen(false); setEmojiOpen(false) }
  const handleFile = async (file?: File) => { if (!file || !onUpload) return; setUploading(true); setUploadProgress(0); setUploadName(file.name); setComposerError(''); try { await onUpload(chat, file, setUploadProgress) } catch (reason) { setComposerError(reason instanceof Error ? reason.message : 'Unable to upload attachment') } finally { setUploading(false); setUploadName(''); if (fileInputRef.current) fileInputRef.current.value = '' } }
  const visibleMessages = searchQuery.trim() ? messages.filter(message => `${message.text} ${message.attachment?.name || ''}`.toLowerCase().includes(searchQuery.trim().toLowerCase())) : messages
  return <main className="conversation">
    <header className="conversation-header"><div className="conversation-person"><button className="conversation-back icon-btn" onClick={onBack} aria-label="Back to contacts"><ArrowLeft size={18} /></button><Avatar chat={chat} /><div><h2>{chat.name}</h2><p><span className="status-dot" /> {chat.status === 'online' ? 'Online' : chat.status === 'away' ? 'Away' : 'Offline'}{muted && <span className="muted-label"> · Muted</span>}</p></div></div><div className="conversation-actions"><button onClick={() => onCall('audio')} className="icon-btn" aria-label="Audio call"><Phone size={18} /></button><button onClick={() => onCall('video')} className="icon-btn" aria-label="Video call"><Video size={18} /></button><button className="icon-btn desktop-only" onClick={() => setSearchOpen(value => !value)} aria-label="Search messages" aria-pressed={searchOpen}><Search size={18} /></button><div className="conversation-menu-wrap"><button className="icon-btn" onClick={() => setOptionsOpen(value => !value)} aria-label="More options" aria-expanded={optionsOpen}><MoreVertical size={18} /></button>{optionsOpen && <div className="conversation-menu"><button onClick={() => { setSearchOpen(true); setOptionsOpen(false) }}><Search size={15} /><span>Search messages</span></button><button onClick={() => { setMuted(value => !value); setOptionsOpen(false) }}><Bell size={15} /><span>{muted ? 'Unmute notifications' : 'Mute notifications'}</span></button><button onClick={() => { setDetailsOpen(value => !value); setOptionsOpen(false) }}><CircleHelp size={15} /><span>Contact details</span></button></div>}{detailsOpen && <div className="contact-details-popover"><strong>{chat.name}</strong><span>{chat.handle}</span><span>{chat.status === 'online' ? 'Online now' : 'Private contact'}</span></div>}</div></div></header>
    {searchOpen && <div className="message-search"><Search size={15} /><input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search this conversation" aria-label="Search this conversation" /><button onClick={() => { setSearchQuery(''); setSearchOpen(false) }} aria-label="Close message search"><X size={15} /></button></div>}
    <div className="message-scroll"><div className="day-divider"><span>{searchQuery.trim() ? `${visibleMessages.length} result${visibleMessages.length === 1 ? '' : 's'}` : 'Today'}</span></div>{visibleMessages.map(message => <MessageBubble key={message.id} message={message} token={token} />)}{searchQuery.trim() && !visibleMessages.length && <div className="search-empty"><Search size={20} /><span>No messages match “{searchQuery}”.</span></div>}{typing && !searchQuery.trim() && <div className="typing-row"><Avatar chat={chat} size="sm" /><div className="typing-bubble"><span /><span /><span /></div><small>{chat.name.split(' ')[0]} is typing...</small></div>}<div ref={endRef} /></div>
    <div className="composer-wrap"><div className="composer-shell">{uploading && <div className="upload-progress" aria-live="polite"><div className="upload-progress-copy"><span><Paperclip size={14} /> Sending {uploadName}</span><strong>{uploadProgress}%</strong></div><div className="upload-progress-track"><span style={{ width: `${Math.max(uploadProgress, 3)}%` }} /></div></div>}<div className="composer-popovers">{attachmentMenuOpen && <div className="attachment-menu"><strong>Add to message</strong><button onClick={() => { setEmojiOpen(true); setAttachmentMenuOpen(false) }}><Smile size={17} /><span>Emoji</span></button><button onClick={() => openPicker('image/*')}><Image size={17} /><span>Image</span></button><button onClick={() => openPicker('image/gif')}><Sparkles size={17} /><span>GIF file</span></button><button onClick={() => openPicker('video/*')}><Video size={17} /><span>Video</span></button><button onClick={() => openPicker('*/*')}><Paperclip size={17} /><span>File</span></button></div>}{emojiOpen && <div className="emoji-menu">{quickEmojis.map(emoji => <button key={emoji} onClick={() => { setDraft(value => `${value}${emoji}`); setEmojiOpen(false); setAttachmentMenuOpen(false) }} aria-label={`Add ${emoji}`}>{emoji}</button>)}</div>}</div><div className="composer"><button className={`composer-icon ${attachmentMenuOpen ? 'active' : ''}`} onClick={() => { setAttachmentMenuOpen(value => !value); setEmojiOpen(false) }} aria-label="Add attachment" aria-expanded={attachmentMenuOpen}><Plus size={20} /></button><input value={draft} onChange={event => { setDraft(event.target.value); setComposerError(''); onTyping?.(chat, event.target.value.length > 0) }} onKeyDown={event => { if (event.key === 'Enter') void send() }} placeholder={uploading ? 'Uploading attachment...' : `Message ${chat.name}...`} aria-label={`Message ${chat.name}`} disabled={uploading} /><button className="composer-icon" onClick={() => { setEmojiOpen(value => !value); setAttachmentMenuOpen(false) }} aria-label="Emoji"><Smile size={19} /></button><button className="send-btn" onClick={() => void send()} aria-label="Send message" disabled={uploading}><Send size={18} /></button></div><input ref={fileInputRef} className="hidden-file-input" type="file" onChange={event => void handleFile(event.target.files?.[0])} />{composerError && <p className="composer-error">{composerError}</p>}</div><div className="composer-meta"><span><ShieldCheck size={12} /> Private conversation</span><span>Enter to send</span></div></div>
  </main>
}

function UtilityRail({ chat, onCall }: { chat: Chat; onCall: (kind: 'audio' | 'video') => void }) {
  return <aside className="utility-rail"><div className="rail-profile"><Avatar chat={chat} size="lg" /><h2>{chat.name}</h2><p>{chat.handle}</p><span className="online-label"><i /> {chat.status === 'online' ? 'Online now' : 'Recently active'}</span></div><div className="rail-actions"><button onClick={() => onCall('audio')}><Phone size={17} />Audio call</button><button onClick={() => onCall('video')}><Video size={17} />Video call</button></div><div className="rail-divider" /><div className="rail-section"><div className="rail-section-heading"><span>Shared media</span><button>View all</button></div><div className="media-grid"><div><Image size={16} /></div><div><FileText size={16} /></div><div><Play size={16} /></div></div></div><div className="rail-section privacy-note"><ShieldCheck size={17} /><div><strong>Private by design</strong><span>Only you and {chat.name.split(' ')[0]} can see this conversation.</span></div></div></aside>
}

function CallOverlay({ chat, kind, state, onAccept, onDecline, onCancel, mediaRef, localMediaRef, audioRef, error, filterId, onFilterChange, micEnabled, cameraEnabled, onToggleMic, onToggleCamera }: { chat: Chat; kind: 'audio' | 'video'; state: 'incoming' | 'calling' | 'connected'; onAccept: () => void; onDecline: () => void; onCancel: () => void; mediaRef: React.RefObject<HTMLVideoElement | null>; localMediaRef: React.RefObject<HTMLVideoElement | null>; audioRef: React.RefObject<HTMLAudioElement | null>; error?: string; filterId: string; onFilterChange: (id: string) => void; micEnabled: boolean; cameraEnabled: boolean; onToggleMic: () => void; onToggleCamera: () => void }) {
  const videoCall = kind === 'video'
  return <div className={`call-overlay ${videoCall ? 'video-call-overlay' : ''}`}><div className="call-glow" /><div className={`call-card ${videoCall ? 'video-call-card' : ''}`}><audio ref={audioRef} autoPlay playsInline /><button className="call-close" onClick={state === 'incoming' ? onDecline : onCancel}><X size={18} /></button><p className="call-eyebrow">{state === 'incoming' ? 'Incoming call' : state === 'connected' ? 'Connected' : 'Calling...'}</p>{videoCall ? <div className="call-video-stage"><video ref={mediaRef} className={`call-media ${state === 'connected' ? '' : 'call-media-hidden'}`} autoPlay playsInline /><video ref={localMediaRef} className="call-local-media" autoPlay muted playsInline /></div> : <div className="call-avatar-wrap"><PulseRings /><Avatar chat={chat} size="lg" /></div>}<h2>{chat.name}</h2><span className="call-type">{kind === 'audio' ? <Phone size={15} /> : <Video size={15} />}{state === 'incoming' ? `${kind === 'audio' ? 'Audio' : 'Video'} call` : state === 'connected' ? 'Connected' : 'Waiting for answer'}</span>{videoCall && state === 'connected' && <label className="call-filter-control"><span>Video filter</span><select value={filterId} onChange={event => onFilterChange(event.target.value)} aria-label="Video filter">{cameraFilters.map(filter => <option key={filter.id} value={filter.id}>{filter.label}</option>)}</select></label>}{error && <p className="form-error call-error">{error}</p>}{state !== 'connected' && <RingtonePreview active={true} onToggle={() => undefined} />}{state === 'connected' && <div className="call-media-controls"><button className={!micEnabled ? 'disabled' : ''} onClick={onToggleMic} aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'} aria-pressed={!micEnabled}>{micEnabled ? <Mic size={17} /> : <MicOff size={17} />}<span>{micEnabled ? 'Mute' : 'Unmute'}</span></button>{videoCall && <button className={!cameraEnabled ? 'disabled' : ''} onClick={onToggleCamera} aria-label={cameraEnabled ? 'Turn camera off' : 'Turn camera on'} aria-pressed={!cameraEnabled}>{cameraEnabled ? <Video size={17} /> : <VideoOff size={17} />}<span>{cameraEnabled ? 'Camera' : 'Camera off'}</span></button>}</div>}<div className="call-controls">{state === 'incoming' ? <><button className="decline" onClick={onDecline}><Phone size={20} />Decline</button><button className="accept" onClick={onAccept}><Phone size={20} />Accept</button></> : state === 'calling' ? <button className="decline" onClick={onCancel}><Phone size={20} />Cancel call</button> : <button className="decline end-call-button" onClick={onCancel}><Phone size={20} />End call</button>}</div></div></div>
}

function ContactsView({ contacts, searchResults, requests, onSearch, onOpen, onCall, onAdd, onAccept }: { contacts: Contact[]; searchResults: Contact[]; requests: ContactRequest[]; onSearch: (query: string) => void; onOpen: (contact: Contact) => void; onCall: (contact: Contact, kind: 'audio' | 'video') => void; onAdd?: (username: string) => Promise<void>; onAccept: (requestId: string) => Promise<void> }) {
  const [query, setQuery] = useState('')
  const [addingUsername, setAddingUsername] = useState('')
  const [addedUsernames, setAddedUsernames] = useState<string[]>([])
  const [addError, setAddError] = useState('')
  const [notice, setNotice] = useState('')
  const [acceptingId, setAcceptingId] = useState('')
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')
  const runSearch = (value: string) => { setQuery(value); onSearch(value) }
  const addContact = async (username: string) => { if (!onAdd || addingUsername) return; setAddError(''); setNotice(''); setAddingUsername(username); try { await onAdd(username); setAddedUsernames(prev => prev.includes(username) ? prev : [...prev, username]); setNotice(`Contact request sent to @${username}`) } catch (reason) { setAddError(reason instanceof Error ? reason.message : 'Unable to send contact request') } finally { setAddingUsername('') } }
  const acceptRequest = async (request: ContactRequest) => { setAddError(''); setAcceptingId(request.id); try { await onAccept(request.id); setNotice(`${request.display_name} is now in your contacts`) } catch (reason) { setAddError(reason instanceof Error ? reason.message : 'Unable to accept contact request') } finally { setAcceptingId('') } }
  return <div className="contacts-view"><div className="settings-heading"><p className="eyebrow">Your network</p><h1>Contacts</h1><p>Search for someone, add them, then message or call from your contact list.</p></div><div className="contact-search search-field"><Search size={16} /><input value={query} onChange={event => runSearch(event.target.value)} placeholder="Search by username or name..." /></div>{notice && <p className="contact-notice">{notice}</p>}{addError && <p className="form-error contact-notice-error">{addError}</p>}{requests.length > 0 && <section className="contacts-card contact-requests-card"><div className="contacts-card-heading"><div><h3>Contact requests</h3><p>Accept requests to start messaging and calling.</p></div><UserRoundPlus size={19} /></div>{requests.map(request => <div className="contact-row" key={request.id}><div className="contact-avatar">{request.display_name.slice(0, 2).toUpperCase()}</div><div className="contact-copy"><strong>{request.display_name}</strong><span>@{request.username}</span></div><div className="contact-actions"><button className="contact-add" onClick={() => void acceptRequest(request)} disabled={acceptingId === request.id}><Check size={14} />{acceptingId === request.id ? 'Accepting...' : 'Accept'}</button></div></div>)}</section>}<section className={`contacts-card ${viewMode === 'grid' ? 'contacts-grid-card' : ''}`}><div className="contacts-card-heading"><div><h3>{query ? 'Search results' : 'Your contacts'}</h3><p>{query ? 'Add a person or open a private conversation.' : 'Your connected people, ready to reach.'}</p></div><div className="contact-view-toggle" aria-label="Contact view"><button className={viewMode === 'list' ? 'active' : ''} aria-label="List view" aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')}><List size={16} /></button><button className={viewMode === 'grid' ? 'active' : ''} aria-label="Grid view" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}><LayoutGrid size={16} /></button></div></div>{(query ? searchResults : contacts).length ? (query ? searchResults : contacts).map(contact => { const isExistingContact = contacts.some(item => item.id === contact.id); const requestSent = addedUsernames.includes(contact.username); return <div className="contact-row" key={contact.id}><div className="contact-avatar">{contact.display_name.slice(0, 2).toUpperCase()}</div><div className="contact-copy"><strong>{contact.display_name}</strong><span>@{contact.username}</span></div><div className="contact-actions">{query && (isExistingContact ? <span className="contact-added">Added</span> : requestSent ? <span className="contact-added">Request sent</span> : <button className="contact-add" onClick={() => void addContact(contact.username)} disabled={addingUsername === contact.username}><UsersRound size={14} />{addingUsername === contact.username ? 'Adding...' : 'Add contact'}</button>)}<button className="contact-open" onClick={() => onOpen(contact)} aria-label={`Message ${contact.display_name}`}><Send size={14} /><span className="contact-open-label">Message</span></button><button className="contact-call" onClick={() => onCall(contact, 'audio')} aria-label={`Call ${contact.display_name}`}><Phone size={15} /></button><button className="contact-call" onClick={() => onCall(contact, 'video')} aria-label={`Video call ${contact.display_name}`}><Video size={15} /></button></div></div> }) : <div className="contacts-empty"><UsersRound size={25} /><strong>{query ? 'No people found' : 'Your contact list is empty'}</strong><span>{query ? 'Try another name or username.' : 'Search above to find someone and start a chat.'}</span></div>}</section></div>
}

function CallsView({ token, onOpenContact }: { token: string; onOpenContact: (contact: Contact) => void }) {
  const [history, setHistory] = useState<CallHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true)
    apiRequest<CallHistoryItem[]>('/calls/history', {}, token).then(result => { if (active) setHistory(result) }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load call history') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [token])
  const statusLabel = (item: CallHistoryItem) => item.status === 'missed' ? 'Missed' : item.status === 'ended' ? 'Completed' : item.status === 'answered' ? 'Connected' : 'Calling'
  return <div className="calls-view"><div className="settings-heading"><p className="eyebrow">Your activity</p><h1>Calls</h1><p>Review recent audio and video calls from your private workspace.</p></div><section className="calls-card"><div className="calls-card-heading"><div><h3>Call history</h3><p>Only your recent call activity is stored here.</p></div><Clock3 size={19} /></div>{loading && <div className="calls-state"><Clock3 size={20} /><span>Loading call history...</span></div>}{!loading && error && <div className="calls-state calls-error"><span>{error}</span></div>}{!loading && !error && history.length === 0 && <div className="calls-state"><Phone size={22} /><strong>No calls yet</strong><span>Start an audio or video call from Contacts.</span></div>}{!loading && !error && history.length > 0 && <div className="call-history-list">{history.map(item => { const CallIcon = item.kind === 'video' ? Video : Phone; return <article className={`call-history-row ${item.status}`} key={item.id}><div className={`call-history-icon ${item.direction}`}><CallIcon size={17} /></div><div className="call-history-copy"><strong>{item.display_name}</strong><span>{item.direction === 'incoming' ? 'Incoming' : 'Outgoing'} {item.kind} call · {statusLabel(item)}</span></div><time>{formatMessageTime(item.created_at)}</time><button className="call-history-message" onClick={() => onOpenContact({ id: item.user_id, username: item.username, display_name: item.display_name })} aria-label={`Message ${item.display_name}`}><Send size={15} /></button></article> })}</div>}</section></div>
}

function NoConversationsView({ onFindPeople }: { onFindPeople: () => void }) {
  return <div className="empty-view"><div className="empty-icon"><Inbox size={28} /></div><h1>No conversations yet</h1><p>Search for someone in Contacts to start your first private chat.</p><button className="primary-btn" onClick={onFindPeople}><UsersRound size={17} />Find people</button></div>
}

const cameraFilters = [
  { id: 'natural', label: 'Natural', css: 'none' },
  { id: 'mono', label: 'Mono', css: 'grayscale(1) contrast(1.08)' },
  { id: 'warm', label: 'Warm', css: 'sepia(.28) saturate(1.2) contrast(1.04)' },
  { id: 'neon', label: 'Neon', css: 'saturate(1.7) contrast(1.16) hue-rotate(12deg)' },
  { id: 'soft', label: 'Soft focus', css: 'brightness(1.06) saturate(.82) contrast(.94)' },
]

async function createVideoFilterPipeline(source: MediaStream, initialCss: string): Promise<VideoFilterPipeline | null> {
  const sourceTrack = source.getVideoTracks()[0]
  if (!sourceTrack || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null
  const settings = sourceTrack.getSettings()
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  const width = settings.width || 640
  const height = settings.height || 360
  canvas.width = width; canvas.height = height
  video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([sourceTrack])
  await video.play()
  const context = canvas.getContext('2d')
  if (!context) return null
  let css = initialCss
  let frame = 0
  const draw = () => {
    context.filter = css
    context.drawImage(video, 0, 0, width, height)
    frame = window.requestAnimationFrame(draw)
  }
  draw()
  const output = canvas.captureStream(30)
  const track = output.getVideoTracks()[0]
  if (!track) return null
  return {
    track,
    setFilter: nextCss => { css = nextCss },
    dispose: () => { window.cancelAnimationFrame(frame); video.pause(); video.srcObject = null; output.getTracks().forEach(outputTrack => outputTrack.stop()) },
  }
}

function CameraStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user')
  const [filterId, setFilterId] = useState('natural')
  const [captured, setCaptured] = useState('')
  const [error, setError] = useState('')
  const activeFilter = cameraFilters.find(filter => filter.id === filterId) || cameraFilters[0]

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    const start = async () => {
      setError('')
      setCaptured('')
      if (!navigator.mediaDevices?.getUserMedia) { setError('Camera access is not supported in this browser.'); return }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } } })
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return }
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => undefined) }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof DOMException && reason.name === 'NotAllowedError' ? 'Camera permission is blocked. Allow camera access to use the studio.' : 'Unable to start the camera on this device.')
      }
    }
    void start()
    return () => { cancelled = true; stream?.getTracks().forEach(track => track.stop()); if (videoRef.current) videoRef.current.srcObject = null }
  }, [facingMode])

  const capture = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) { setError('Wait for the camera preview to become ready.'); return }
    canvas.width = video.videoWidth; canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) return
    context.save(); context.filter = activeFilter.css
    if (facingMode === 'user') { context.translate(canvas.width, 0); context.scale(-1, 1) }
    context.drawImage(video, 0, 0, canvas.width, canvas.height); context.restore()
    setCaptured(canvas.toDataURL('image/jpeg', .9)); setError('')
  }

  const downloadCapture = () => {
    if (!captured) return
    const link = document.createElement('a'); link.href = captured; link.download = `contak-capture-${Date.now()}.jpg`; link.click()
  }

  return <div className="camera-studio"><div className="settings-heading"><p className="eyebrow">Local camera studio</p><h1>Camera</h1><p>Preview and capture with device-side filters. Nothing is uploaded.</p></div><div className="camera-studio-grid"><section className="camera-preview-card"><div className="camera-preview-frame"><video ref={videoRef} className="camera-preview" autoPlay muted playsInline style={{ filter: activeFilter.css, transform: facingMode === 'user' ? 'scaleX(-1)' : undefined }} /><div className="camera-preview-badge"><span />Device only</div>{error && <div className="camera-preview-error"><Camera size={21} /><strong>{error}</strong><span>Check your browser permission and try again.</span></div>}</div><div className="camera-toolbar"><button className="camera-tool" onClick={() => setFacingMode(mode => mode === 'user' ? 'environment' : 'user')}><FlipHorizontal2 size={17} /><span>Flip</span></button><button className="camera-capture" onClick={capture} aria-label="Capture photo"><Camera size={22} /></button><button className="camera-tool" onClick={() => { setFilterId('natural'); setCaptured(''); setError('') }}><RotateCcw size={17} /><span>Reset</span></button></div></section><aside className="camera-controls-card"><div className="camera-card-heading"><div><h3>Filters</h3><p>Live device-side preview</p></div><Sparkles size={19} /></div><div className="camera-filter-grid">{cameraFilters.map(filter => <button key={filter.id} className={filter.id === activeFilter.id ? 'active' : ''} onClick={() => setFilterId(filter.id)}><span className="camera-filter-swatch" style={{ filter: filter.css }} /><strong>{filter.label}</strong></button>)}</div>{captured && <div className="camera-capture-result"><img src={captured} alt="Captured Contak preview" /><button className="primary-btn" onClick={downloadCapture}><Download size={16} />Download capture</button></div>}<p className="camera-privacy-note"><ShieldCheck size={15} /> Camera processing stays on this device.</p></aside></div><canvas ref={canvasRef} className="camera-canvas" /></div>
}

function PushNotificationSettings({ token }: { token: string }) {
  const [mode, setMode] = useState<NotificationMode>('off')
  const [permission, setPermission] = useState('default')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    apiRequest<{ mode: NotificationMode }>('/notifications/preferences', {}, token).then(result => { if (active) setMode(result.mode) }).catch(() => undefined)
    if (typeof Notification !== 'undefined') setPermission(Notification.permission)
    return () => { active = false }
  }, [token])
  const changeMode = async (nextMode: NotificationMode) => {
    if (busy || nextMode === mode) return
    const previousMode = mode; setMode(nextMode); setError(''); setBusy(true)
    try { const result = await syncPushSubscription(token, nextMode); setPermission(result.permission) } catch (reason) { setMode(previousMode); setError(reason instanceof Error ? reason.message : 'Unable to update notification settings') } finally { setBusy(false) }
  }
  return <section className="settings-card notification-settings-card"><div className="settings-card-heading"><div className="settings-icon violet"><Bell size={17} /></div><div><h3>Message notifications</h3><p>Choose how new messages reach you on this device.</p></div></div><div className="notification-mode-options" role="group" aria-label="Message notification mode">{([['on', 'On', 'Standard alerts'], ['silent', 'Silent', 'Show without sound'], ['off', 'Off', 'No push alerts']] as const).map(([value, label, description]) => <button key={value} className={mode === value ? 'active' : ''} onClick={() => void changeMode(value)} disabled={busy} aria-pressed={mode === value}><strong>{label}</strong><span>{description}</span></button>)}</div><p className="notification-status">{busy ? 'Updating notification settings...' : permission === 'denied' && mode !== 'off' ? 'Notifications are blocked in this browser. Allow them in site settings.' : mode === 'silent' ? 'New messages will appear without notification sound.' : mode === 'on' ? 'You will be notified when a new message arrives.' : 'Browser message notifications are turned off.'}</p>{error && <p className="form-error notification-error">{error}</p>}</section>
}

function SettingsView({ user, token, onLogout }: { user: User; token: string; onLogout: () => void }) {
  const [ringtonePlaying, setRingtonePlaying] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState('')
  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault(); setPasswordError(''); setPasswordSuccess('')
    if (newPassword !== confirmPassword) { setPasswordError('New passwords do not match'); return }
    setPasswordBusy(true)
    try {
      await apiRequest('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }, token)
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordSuccess('Password updated successfully')
    } catch (reason) { setPasswordError(reason instanceof Error ? reason.message : 'Unable to update password') } finally { setPasswordBusy(false) }
  }
  return <div className="settings-view"><div className="settings-heading"><p className="eyebrow">Control center</p><h1>Settings</h1><p>Shape your Contak.App experience.</p></div><div className="settings-grid"><section className="settings-card profile-settings-card"><div className="settings-card-heading"><div className="settings-icon violet"><UserCog size={17} /></div><div><h3>Profile</h3><p>Your Contak.App identity.</p></div></div><div className="profile-settings-row"><div className="avatar sm"><span>{user.display_name.slice(0, 2).toUpperCase()}</span><i className="presence online" /></div><div><strong>{user.display_name}</strong><span>@{user.username} · {user.email}</span></div></div><button className="settings-signout" onClick={onLogout}>Sign out</button></section><section className="settings-card password-settings-card"><div className="settings-card-heading"><div className="settings-icon blue"><ShieldCheck size={17} /></div><div><h3>Change password</h3><p>Use your current password to protect your account.</p></div></div><form className="profile-form" onSubmit={changePassword}><label>Current password<input type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><label>New password<input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></label><label>Confirm new password<input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></label>{passwordError && <p className="form-error">{passwordError}</p>}{passwordSuccess && <p className="form-success">{passwordSuccess}</p>}<button className="primary-btn" disabled={passwordBusy}>{passwordBusy ? 'Updating...' : 'Update password'}</button></form></section><section className="settings-card"><div className="settings-card-heading"><div className="settings-icon violet"><Bell size={17} /></div><div><h3>Call & notification sounds</h3><p>Make every call feel unmistakably yours.</p></div></div><div className="setting-row"><div><strong>Default ringtone</strong><span>Incoming calls on this device</span></div><RingtonePreview active={ringtonePlaying} onToggle={() => setRingtonePlaying(value => !value)} /></div><div className="setting-row"><div><strong>Vibration</strong><span>Use haptics for incoming calls</span></div><button className="toggle on"><span /></button></div><div className="setting-row"><div><strong>Do Not Disturb</strong><span>Pause notifications until you turn it off</span></div><button className="toggle"><span /></button></div></section><PushNotificationSettings token={token} /><section className="settings-card"><div className="settings-card-heading"><div className="settings-icon blue"><ShieldCheck size={17} /></div><div><h3>Privacy</h3><p>Keep your presence and conversations yours.</p></div></div><div className="setting-row"><div><strong>Show online status</strong><span>Let contacts see when you’re around</span></div><button className="toggle on"><span /></button></div><div className="setting-row"><div><strong>Read receipts</strong><span>Show when you’ve read messages</span></div><button className="toggle on"><span /></button></div></section></div></div>
}

type AdminOverviewData = { totalUsers: number; activeUsers: number; conversationsToday: number; messagesToday: number; apiHealth: string }
type AdminUser = { id: string; username: string; display_name: string; role: 'user' | 'admin'; suspended_until?: string; suspension_reason?: string; created_at: string; last_active: string; messages_count: number }
type AdminActivity = { type: string; subject: string; detail: string; created_at: string }
type AdminReport = { id: string; reason: string; details?: string; status: 'open' | 'resolved' | 'dismissed'; created_at: string; reporter_username: string; reported_username: string; reported_display_name: string }
type AdminSystem = { api: string; database: string; realtime: string; version: string; uptimeSeconds: number; environment: string }
type AdminConversations = { total: number; today: number; messagesToday: number; recent: { id: string; created_at: string; messages_count: number; participants: string }[] }
const adminNav = [{ id: 'overview', label: 'Overview', icon: LayoutGrid }, { id: 'users', label: 'Users', icon: UsersRound }, { id: 'conversations', label: 'Conversations', icon: Inbox }, { id: 'moderation', label: 'Moderation', icon: Shield }, { id: 'reports', label: 'Reports', icon: BarChart3 }, { id: 'integrations', label: 'API & Integrations', icon: Database }, { id: 'settings', label: 'Settings', icon: Settings }]
function relativeTime(value: string) { const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60_000)); return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} hr ago` }
function AdminReportsView({ reports, onResolve }: { reports: AdminReport[]; onResolve: (id: string, status: 'resolved' | 'dismissed') => void }) { return <div className="admin-feature-grid"><section className="admin-panel admin-feature-panel"><div className="admin-panel-heading"><div><h2>Open reports</h2><p>Review policy reports and keep the network healthy.</p></div><Shield size={19} /></div>{reports.length ? <div className="report-list">{reports.map(report => <div className="report-row" key={report.id}><span className="activity-icon violet"><ShieldCheck size={16} /></span><div className="report-copy"><strong>{report.reason}</strong><span>@{report.reported_username} reported by @{report.reporter_username}</span><small>{report.details || 'No additional details provided.'}</small></div><time>{relativeTime(report.created_at)}</time><div className="report-actions"><button onClick={() => onResolve(report.id, 'resolved')}>Resolve</button><button onClick={() => onResolve(report.id, 'dismissed')}>Dismiss</button></div></div>)}</div> : <div className="feature-empty"><ShieldCheck size={26} /><strong>No open reports</strong><span>New reports will appear here for review.</span></div>}</section><section className="admin-panel admin-feature-panel moderation-guide"><div className="admin-panel-heading"><div><h2>Moderation controls</h2><p>Actions are logged and reversible.</p></div><UserCog size={19} /></div><div className="guide-row"><ShieldCheck size={17} /><div><strong>Review first</strong><span>Resolve reports only after checking the reported context.</span></div></div><div className="guide-row"><Clock3 size={17} /><div><strong>Temporary restrictions</strong><span>Restrict accounts for up to 30 days from Users.</span></div></div><div className="guide-row"><Activity size={17} /><div><strong>Live protection</strong><span>Restricted accounts cannot access messaging routes.</span></div></div></section></div> }
function AdminIntegrationsView({ system }: { system: AdminSystem | null }) { const row = (label: string, value: string) => <div className="system-row"><span>{label}</span><strong><i />{value}</strong></div>; return <div className="admin-feature-grid"><section className="admin-panel admin-feature-panel"><div className="admin-panel-heading"><div><h2>System health</h2><p>Live status from the Contak.App service stack.</p></div><Activity size={19} /></div><div className="system-list">{row('API service', system?.api || 'Checking...')}{row('PostgreSQL', system?.database || 'Checking...')}{row('Realtime gateway', system?.realtime || 'Checking...')}</div></section><section className="admin-panel admin-feature-panel"><div className="admin-panel-heading"><div><h2>Deployment details</h2><p>Runtime information for this environment.</p></div><Database size={19} /></div><div className="system-list"><div className="system-row"><span>Version</span><strong>{system?.version || '—'}</strong></div><div className="system-row"><span>Environment</span><strong>{system?.environment || '—'}</strong></div><div className="system-row"><span>API uptime</span><strong>{system ? `${Math.round(system.uptimeSeconds / 60)} min` : '—'}</strong></div></div></section></div> }
function AdminSettingsView({ session, onLogout }: { session: AuthSession; onLogout: () => void }) { return <div className="admin-feature-grid"><section className="admin-panel admin-feature-panel"><div className="admin-panel-heading"><div><h2>Administrator profile</h2><p>Signed-in identity and access level.</p></div><UserCog size={19} /></div><div className="admin-profile-row"><span className="admin-user-avatar">{session.user.display_name.slice(0, 2).toUpperCase()}</span><div><strong>{session.user.display_name}</strong><span>@{session.user.username} · {session.user.email}</span></div><b>Admin</b></div><button className="admin-danger-button" onClick={onLogout}>Sign out of admin</button></section><section className="admin-panel admin-feature-panel"><div className="admin-panel-heading"><div><h2>Security posture</h2><p>Current protections for the control plane.</p></div><ShieldCheck size={19} /></div><div className="guide-row"><ShieldCheck size={17} /><div><strong>Protected routes</strong><span>All admin endpoints require an administrator token.</span></div></div><div className="guide-row"><Database size={17} /><div><strong>Private database</strong><span>Credentials and message content stay on the VPS.</span></div></div></section></div> }
function AdminConversationsView({ data }: { data: AdminConversations | null }) { return <><section className="admin-metrics admin-conversation-metrics">{[['Total conversations', data?.total ?? '—'], ['Started today', data?.today ?? '—'], ['Messages today', data?.messagesToday ?? '—']].map(([label, value], index) => <div className={`admin-metric ${index === 1 ? 'cyan' : index === 2 ? 'purple' : 'violet'}`} key={label}><Inbox size={20} /><span>{label}</span><strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong><small>Live platform total</small></div>)}</section><div className="admin-feature-grid"><section className="admin-panel admin-feature-panel conversation-table-panel"><div className="admin-panel-heading"><div><h2>Recent conversations</h2><p>Conversation rooms ordered by creation time.</p></div><Inbox size={19} /></div><div className="admin-table-wrap"><table><thead><tr><th>Participants</th><th>Created</th><th>Messages</th><th>Conversation ID</th></tr></thead><tbody>{data?.recent.length ? data.recent.map(item => <tr key={item.id}><td>{item.participants}</td><td>{relativeTime(item.created_at)}</td><td>{item.messages_count.toLocaleString()}</td><td className="conversation-id">{item.id.slice(0, 8)}…</td></tr>) : <tr><td colSpan={4}>No conversations yet.</td></tr>}</tbody></table></div></section></div></> }
function AdminDashboard({ session, onLogout }: { session: AuthSession; onLogout: () => void }) {
  const [active, setActive] = useState('overview'); const [overview, setOverview] = useState<AdminOverviewData | null>(null); const [users, setUsers] = useState<AdminUser[]>([]); const [activity, setActivity] = useState<AdminActivity[]>([]); const [reports, setReports] = useState<AdminReport[]>([]); const [system, setSystem] = useState<AdminSystem | null>(null); const [conversations, setConversations] = useState<AdminConversations | null>(null); const [search, setSearch] = useState(''); const [error, setError] = useState('')
  const load = async (query = search) => { try { setError(''); const [summary, userResult, activityResult, reportResult, systemResult, conversationResult] = await Promise.all([apiRequest<AdminOverviewData>('/admin/overview', {}, session.token), apiRequest<{ users: AdminUser[] }>(`/admin/users?limit=8&q=${encodeURIComponent(query)}`, {}, session.token), apiRequest<AdminActivity[]>('/admin/activity', {}, session.token), apiRequest<AdminReport[]>('/admin/reports?status=open', {}, session.token), apiRequest<AdminSystem>('/admin/system', {}, session.token), apiRequest<AdminConversations>('/admin/conversations', {}, session.token)]); setOverview(summary); setUsers(userResult.users); setActivity(activityResult); setReports(reportResult); setSystem(systemResult); setConversations(conversationResult) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load admin data') } }
  useEffect(() => { load('') }, [session.token])
  const restrictUser = async (user: AdminUser) => { try { if (user.suspended_until && new Date(user.suspended_until).getTime() > Date.now()) await apiRequest(`/admin/users/${user.id}/unrestrict`, { method: 'POST' }, session.token); else await apiRequest(`/admin/users/${user.id}/restrict`, { method: 'POST', body: JSON.stringify({ hours: 24, reason: 'Temporary policy review' }) }, session.token); await load() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update account') } }
  const resolveReport = async (id: string, status: 'resolved' | 'dismissed') => { try { await apiRequest(`/admin/reports/${id}/resolve`, { method: 'POST', body: JSON.stringify({ status }) }, session.token); await load() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update report') } }
  const title = adminNav.find(item => item.id === active)?.label || 'Overview'
  const metric = (label: string, value: number | string, icon: React.ComponentType<{ size?: number }>, tone: string) => { const Icon = icon; return <div className={`admin-metric ${tone}`}><Icon size={20} /><span>{label}</span><strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong><small>{label === 'API health' ? 'All systems operational' : 'Live platform total'}</small></div> }
  const userWorkspace = <><section className="admin-metrics">{metric('Active users', overview?.activeUsers ?? '—', UsersRound, 'violet')}{metric('Conversations today', overview?.conversationsToday ?? '—', Inbox, 'cyan')}{metric('Messages today', overview?.messagesToday ?? '—', Send, 'purple')}{metric('API health', overview?.apiHealth ?? '—', Activity, 'green')}</section><div className="admin-content-grid"><section className="admin-panel admin-users-panel"><div className="admin-panel-heading"><div><h2>User activity</h2><p>{active === 'users' ? 'Manage accounts across your private network.' : 'Recent users and platform activity.'}</p></div><div className="admin-heading-actions"><label className="admin-inline-search"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') load() }} placeholder="Filter users" /></label><button className="admin-filter"><Clock3 size={15} />Last 24 hours<ChevronDown size={14} /></button></div></div><div className="admin-table-wrap"><table><thead><tr><th>User</th><th>Username</th><th>Status</th><th>Last active</th><th>Messages</th><th /></tr></thead><tbody>{users.map(user => { const restricted = Boolean(user.suspended_until && new Date(user.suspended_until).getTime() > Date.now()); return <tr key={user.id}><td><span className="admin-user-cell"><span className="admin-user-avatar">{user.display_name.slice(0, 2).toUpperCase()}</span><strong>{user.display_name}</strong></span></td><td>@{user.username}</td><td><span className={`admin-status ${user.role === 'admin' ? 'admin' : restricted ? 'restricted' : 'online'}`}><i />{user.role === 'admin' ? 'Admin' : restricted ? 'Restricted' : 'Active'}</span></td><td>{relativeTime(user.last_active)}</td><td>{user.messages_count.toLocaleString()}</td><td><button className="table-more" onClick={() => restrictUser(user)} aria-label={`${restricted ? 'Unrestrict' : 'Restrict'} ${user.username}`}><MoreHorizontal size={17} /></button></td></tr> })}</tbody></table></div><div className="admin-table-footer">Showing {users.length} of {(overview?.totalUsers ?? users.length).toLocaleString()} users<button className="admin-page active">1</button><button className="admin-page">2</button><button className="admin-page">3</button></div></section><section className="admin-panel admin-activity-panel"><div className="admin-panel-heading"><div><h2>Recent activity</h2><p>Latest changes in the workspace.</p></div><Activity size={19} /></div><div className="activity-list">{activity.map((item, index) => <div className="activity-row" key={`${item.created_at}-${index}`}><span className={`activity-icon ${index % 2 ? 'green' : 'violet'}`}>{index % 2 ? <UserCog size={16} /> : <ShieldCheck size={16} />}</span><div><strong>{item.type}</strong><span>{item.detail} · {item.subject}</span></div><time>{relativeTime(item.created_at)}</time></div>)}</div></section></div></>
  let content = active === 'overview' || active === 'users' ? userWorkspace : active === 'conversations' ? <AdminConversationsView data={conversations} /> : active === 'moderation' || active === 'reports' ? <AdminReportsView reports={reports} onResolve={resolveReport} /> : active === 'integrations' ? <AdminIntegrationsView system={system} /> : active === 'settings' ? <AdminSettingsView session={session} onLogout={onLogout} /> : <div className="admin-placeholder"><div className="empty-icon"><Shield size={28} /></div><h2>{title}</h2><p>This admin workspace is ready for the next operations module.</p></div>
  return <div className="admin-shell"><aside className="admin-sidebar"><div className="admin-brand"><span className="brand-mark" /><div><strong>Contak.App</strong><span>Admin</span></div></div><nav className="admin-nav">{adminNav.map(({ id, label, icon: Icon }) => <button key={id} className={active === id ? 'active' : ''} onClick={() => setActive(id)}><Icon size={19} /><span>{label}</span></button>)}</nav><div className="admin-health"><span><i />API health</span><strong>{overview?.apiHealth || 'Checking...'}</strong></div></aside><main className="admin-main"><header className="admin-header"><div><p className="eyebrow">Private operations</p><h1>{title}</h1></div><div className="admin-header-actions"><label className="admin-search"><Search size={17} /><input placeholder="Search users, conversations, or IDs..." /></label><button className="icon-btn" onClick={() => load()} aria-label="Refresh dashboard"><Activity size={18} /></button><button className="admin-avatar" onClick={onLogout}>{session.user.display_name.slice(0, 2).toUpperCase()}</button></div></header>{error && <div className="admin-error">{error} <button onClick={() => load()}>Retry</button></div>}{content}</main></div>
}

function PlaceholderView({ activeNav }: { activeNav: string }) { const nav = navItems.find(item => item.id === activeNav); const Icon = nav?.icon || LayoutGrid; return <div className="empty-view"><div className="empty-icon"><Icon size={28} /></div><h1>{nav?.label || 'Workspace'}</h1><p>This space is ready for the next phase of your private communication stack.</p><button className="primary-btn"><Zap size={17} />Explore {nav?.label}</button></div> }

function contactToChat(contact: Contact, conversation?: ApiConversation, status: Chat['status'] = 'offline'): Chat { return { id: contact.id, userId: contact.id, name: contact.display_name, handle: `@${contact.username}`, initials: contact.display_name.slice(0, 2).toUpperCase(), color: '#7c3aed', status, time: conversation?.last_message ? formatMessageTime(conversation.last_message.created_at) : 'New', preview: conversation?.last_message?.body || 'Start a private conversation', unread: conversation?.unread_count || undefined, avatar: '', conversationId: conversation?.id } }
function apiMessageToMessage(message: ApiMessage, currentUserId: string): Message { return { id: message.id, from: message.sender_id === currentUserId ? 'me' : 'them', text: message.body, time: formatMessageTime(message.created_at), read: message.sender_id === currentUserId ? Boolean(message.read) : undefined, attachment: message.attachment } }

function App() {
  const [session, setSession] = useState<AuthSession | null>(() => { try { return JSON.parse(localStorage.getItem('contak-session') || 'null') } catch { return null } })
  const [activeNav, setActiveNav] = useState('contacts'); const [selectedId, setSelectedId] = useState(''); const [contacts, setContacts] = useState<Contact[]>([]); const [contactRequests, setContactRequests] = useState<ContactRequest[]>([]); const [conversations, setConversations] = useState<ApiConversation[]>([]); const [searchResults, setSearchResults] = useState<Contact[]>([]); const [messages, setMessages] = useState<Record<string, Message[]>>({}); const [conversationIds, setConversationIds] = useState<Record<string, string>>({}); const [presenceByUserId, setPresenceByUserId] = useState<Record<string, 'online' | 'offline'>>({}); const [typingByChatId, setTypingByChatId] = useState<Record<string, boolean>>({}); const [call, setCall] = useState<ActiveCall | null>(null); const [callError, setCallError] = useState(''); const [callFilterId, setCallFilterId] = useState('natural'); const [callMicEnabled, setCallMicEnabled] = useState(true); const [callCameraEnabled, setCallCameraEnabled] = useState(true)
  const socketRef = useRef<Socket | null>(null); const conversationIdsRef = useRef<Record<string, string>>({}); const selectedIdRef = useRef(''); const typingTimeoutsRef = useRef<Record<string, number>>({}); const callRef = useRef<ActiveCall | null>(null); const peerConnectionRef = useRef<RTCPeerConnection | null>(null); const localStreamRef = useRef<MediaStream | null>(null); const videoFilterPipelineRef = useRef<VideoFilterPipeline | null>(null); const callFilterIdRef = useRef('natural'); const callMicEnabledRef = useRef(true); const callCameraEnabledRef = useRef(true); const pendingIceRef = useRef<RTCIceCandidateInit[]>([]); const remoteMediaRef = useRef<HTMLVideoElement | null>(null); const localMediaRef = useRef<HTMLVideoElement | null>(null); const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const chatList = useMemo(() => { const merged = new Map<string, Chat>(); contacts.forEach(contact => merged.set(contact.id, contactToChat(contact, undefined, presenceByUserId[contact.id] || 'offline'))); conversations.forEach(conversation => merged.set(conversation.participant.id, contactToChat(conversation.participant, conversation, presenceByUserId[conversation.participant.id] || 'offline'))); return [...merged.values()] }, [contacts, conversations, presenceByUserId])
  const selectedChat = useMemo(() => chatList.find(chat => chat.id === selectedId) || chatList[0] || null, [chatList, selectedId])

  useEffect(() => { if (session && !selectedId && chatList[0]) setSelectedId(chatList[0].id) }, [session, selectedId, chatList])
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  const markConversationRead = async (conversationId: string) => { try { await apiRequest(`/conversations/${conversationId}/read`, { method: 'POST' }, session?.token); setConversations(prev => prev.map(item => item.id === conversationId ? { ...item, unread_count: 0 } : item)) } catch { /* read state is best effort */ } }
  useEffect(() => { callRef.current = call }, [call])
  useEffect(() => { callFilterIdRef.current = callFilterId; const filter = cameraFilters.find(item => item.id === callFilterId); if (filter) videoFilterPipelineRef.current?.setFilter(filter.css) }, [callFilterId])
  useEffect(() => { callMicEnabledRef.current = callMicEnabled }, [callMicEnabled])
  useEffect(() => { callCameraEnabledRef.current = callCameraEnabled }, [callCameraEnabled])
  const clearCallMedia = () => { peerConnectionRef.current?.close(); peerConnectionRef.current = null; videoFilterPipelineRef.current?.dispose(); videoFilterPipelineRef.current = null; localStreamRef.current?.getTracks().forEach(track => track.stop()); localStreamRef.current = null; pendingIceRef.current = []; setCallMicEnabled(true); setCallCameraEnabled(true); if (remoteMediaRef.current) remoteMediaRef.current.srcObject = null; if (localMediaRef.current) localMediaRef.current.srcObject = null; if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null }
  const createPeerConnection = async (activeCall: ActiveCall) => { if (peerConnectionRef.current) return peerConnectionRef.current; if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support microphone or camera calls'); const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: activeCall.kind === 'video' }); let iceServers: RTCIceServer[] = []; try { iceServers = (await apiRequest<{ iceServers: RTCIceServer[] }>('/calls/ice', {}, session?.token)).iceServers } catch { /* host candidates remain available if the TURN config is temporarily unavailable */ } const peer = new RTCPeerConnection({ iceServers }); localStreamRef.current = localStream; const activeFilter = cameraFilters.find(item => item.id === callFilterIdRef.current) || cameraFilters[0]; if (activeCall.kind === 'video') { try { videoFilterPipelineRef.current = await createVideoFilterPipeline(localStream, activeFilter.css) } catch { videoFilterPipelineRef.current = null } } const outboundStream = videoFilterPipelineRef.current ? new MediaStream([...localStream.getAudioTracks(), videoFilterPipelineRef.current.track]) : localStream; outboundStream.getAudioTracks().forEach(track => { track.enabled = callMicEnabledRef.current }); outboundStream.getVideoTracks().forEach(track => { track.enabled = callCameraEnabledRef.current }); if (activeCall.kind === 'video' && localMediaRef.current) { localMediaRef.current.srcObject = outboundStream; void localMediaRef.current.play().catch(() => undefined) } outboundStream.getTracks().forEach(track => peer.addTrack(track, outboundStream)); peer.onicecandidate = event => { if (event.candidate) socketRef.current?.emit('call:signal', { toUserId: activeCall.peerId, callId: activeCall.callId, signal: { type: 'ice', candidate: event.candidate.toJSON() } }) }; peer.ontrack = event => { const stream = event.streams[0]; if (activeCall.kind === 'video' && remoteMediaRef.current) { remoteMediaRef.current.srcObject = stream; void remoteMediaRef.current.play().catch(() => undefined) } if (remoteAudioRef.current) { remoteAudioRef.current.srcObject = stream; void remoteAudioRef.current.play().catch(() => undefined) } }; peer.onconnectionstatechange = () => { if (peer.connectionState === 'connected') setCall(prev => prev?.callId === activeCall.callId ? { ...prev, state: 'connected' } : prev); if (peer.connectionState === 'failed') setCallError('The call connection failed. Check both devices and try again.') }; peerConnectionRef.current = peer; return peer }
  const sendCallOffer = async (activeCall: ActiveCall) => { const peer = await createPeerConnection(activeCall); const offer = await peer.createOffer(); await peer.setLocalDescription(offer); socketRef.current?.emit('call:signal', { toUserId: activeCall.peerId, callId: activeCall.callId, signal: { type: 'offer', description: peer.localDescription } }) }
  const handleCallSignal = async (payload: { callId: string; signal: { type: 'offer' | 'answer' | 'ice'; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => { const activeCall = callRef.current; if (!activeCall || activeCall.callId !== payload.callId) return; try { const peer = await createPeerConnection(activeCall); if (payload.signal.type === 'offer' && payload.signal.description) { await peer.setRemoteDescription(payload.signal.description); for (const candidate of pendingIceRef.current) await peer.addIceCandidate(candidate); pendingIceRef.current = []; const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); socketRef.current?.emit('call:signal', { toUserId: activeCall.peerId, callId: activeCall.callId, signal: { type: 'answer', description: peer.localDescription } }) } else if (payload.signal.type === 'answer' && payload.signal.description) { await peer.setRemoteDescription(payload.signal.description); for (const candidate of pendingIceRef.current) await peer.addIceCandidate(candidate); pendingIceRef.current = [] } else if (payload.signal.type === 'ice' && payload.signal.candidate) { if (peer.remoteDescription) await peer.addIceCandidate(payload.signal.candidate); else pendingIceRef.current.push(payload.signal.candidate) } } catch (reason) { setCallError(reason instanceof Error ? reason.message : 'Unable to start the call') } }

  useEffect(() => {
    if (!session) return
    Promise.all([apiRequest<Contact[]>('/contacts', {}, session.token), apiRequest<ContactRequest[]>('/contacts/requests', {}, session.token), apiRequest<ApiConversation[]>('/conversations', {}, session.token)]).then(([contactResult, requestResult, conversationResult]) => { setContacts(contactResult); setContactRequests(requestResult); setConversations(conversationResult); const ids = Object.fromEntries(conversationResult.map(item => [item.participant.id, item.id])); conversationIdsRef.current = ids; setConversationIds(ids); if (!selectedId) setSelectedId(conversationResult[0]?.participant.id || contactResult[0]?.id || '') }).catch(() => undefined)
    const socket = io({ auth: { token: session.token } }); socketRef.current = socket
    socket.on('message:new', (payload: ApiMessage & { conversation_id?: string }) => { const entry = Object.entries(conversationIdsRef.current).find(([, id]) => id === payload.conversation_id); if (!entry) return; const [chatId] = entry; setMessages(prev => { const next = apiMessageToMessage(payload, session.user.id); return prev[chatId]?.some(message => message.id === next.id) ? prev : { ...prev, [chatId]: [...(prev[chatId] || []), next] } }); setConversations(prev => prev.map(item => item.id === payload.conversation_id ? { ...item, last_message: payload, unread_count: chatId === selectedIdRef.current ? 0 : item.unread_count + 1 } : item)); if (chatId === selectedIdRef.current && payload.conversation_id) markConversationRead(payload.conversation_id) })
    socket.on('receipt:read', (payload: { conversationId: string; userId: string }) => { if (payload.userId === session.user.id) return; const entry = Object.entries(conversationIdsRef.current).find(([, id]) => id === payload.conversationId); if (!entry) return; setMessages(prev => ({ ...prev, [entry[0]]: (prev[entry[0]] || []).map(message => message.from === 'me' ? { ...message, read: true } : message) })) })
    socket.on('presence:update', (payload: { userId: string; status: 'online' | 'offline' }) => { if (payload.userId !== session.user.id) setPresenceByUserId(prev => ({ ...prev, [payload.userId]: payload.status })) })
    socket.on('typing:update', (payload: { conversationId: string; userId: string; status: 'typing' | 'idle' }) => { if (payload.userId === session.user.id) return; const entry = Object.entries(conversationIdsRef.current).find(([, id]) => id === payload.conversationId); if (!entry) return; setTypingByChatId(prev => ({ ...prev, [entry[0]]: payload.status === 'typing' })) })
    socket.on('call:incoming', (payload: { conversationId: string; callId: string; kind: 'audio' | 'video'; fromUserId: string; fromName?: string; fromUsername?: string }) => { const incomingCall = { kind: payload.kind, state: 'incoming' as const, callId: payload.callId, peerId: payload.fromUserId, conversationId: payload.conversationId }; setContacts(prev => prev.some(item => item.id === payload.fromUserId) ? prev : [...prev, { id: payload.fromUserId, username: payload.fromUsername || 'contact', display_name: payload.fromName || 'Contak user' }]); setSelectedId(payload.fromUserId); setCallFilterId('natural'); setCallMicEnabled(true); setCallCameraEnabled(true); callRef.current = incomingCall; setCallError(''); setCall(incomingCall) })
    socket.on('call:accepted', (payload: { callId: string }) => { const activeCall = callRef.current; if (!activeCall || activeCall.callId !== payload.callId) return; setCall({ ...activeCall, state: 'connected' }); void sendCallOffer(activeCall).catch(reason => setCallError(reason instanceof Error ? reason.message : 'Unable to start the call')) })
    socket.on('call:signal', (payload: { callId: string; signal: { type: 'offer' | 'answer' | 'ice'; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => { void handleCallSignal(payload) })
    socket.on('call:ended', (payload: { callId: string }) => { if (callRef.current?.callId !== payload.callId) return; clearCallMedia(); callRef.current = null; setCall(null) })
    const heartbeat = window.setInterval(() => socket.emit('presence:heartbeat'), 30_000)
    return () => { window.clearInterval(heartbeat); Object.values(typingTimeoutsRef.current).forEach(timeout => window.clearTimeout(timeout)); typingTimeoutsRef.current = {}; socket.disconnect(); socketRef.current = null }
  }, [session])

  useEffect(() => {
    if (!session || activeNav !== 'conversation' || !selectedChat?.userId) return
    let cancelled = false
    const load = async () => { try { const conversation = await apiRequest<{ id: string }>(`/conversations/with/${selectedChat.userId}`, { method: 'POST' }, session.token); if (cancelled) return; conversationIdsRef.current = { ...conversationIdsRef.current, [selectedChat.id]: conversation.id }; setConversationIds(prev => ({ ...prev, [selectedChat.id]: conversation.id })); socketRef.current?.emit('conversation:join', conversation.id); const serverMessages = await apiRequest<ApiMessage[]>(`/conversations/${conversation.id}/messages`, {}, session.token); if (!cancelled) { setMessages(prev => ({ ...prev, [selectedChat.id]: serverMessages.map(message => apiMessageToMessage(message, session.user.id)) })); setConversations(prev => prev.map(item => item.id === conversation.id ? { ...item, unread_count: 0 } : item)) } } catch { if (!cancelled) setMessages(prev => ({ ...prev, [selectedChat.id]: prev[selectedChat.id] || [] })) } }
    load(); return () => { cancelled = true }
  }, [session, activeNav, selectedChat?.id])

  if (!session) return <AuthScreen onAuthenticated={authenticatedSession => { setSession(authenticatedSession); setActiveNav('contacts'); setSelectedId('') }} />
  if (session.user.role === 'admin') return <AdminDashboard session={session} onLogout={() => { localStorage.removeItem('contak-session'); setSession(null) }} />
  const beginCall = async (chat: Chat, kind: 'audio' | 'video') => { if (!chat.userId || !socketRef.current) return; let conversationId = conversationIdsRef.current[chat.id] || chat.conversationId; if (!conversationId) { try { const created = await apiRequest<{ id: string }>(`/conversations/with/${chat.userId}`, { method: 'POST' }, session.token); conversationId = created.id; conversationIdsRef.current = { ...conversationIdsRef.current, [chat.id]: created.id }; setConversationIds(prev => ({ ...prev, [chat.id]: created.id })); socketRef.current.emit('conversation:join', created.id) } catch { return } } setCallFilterId('natural'); setCallMicEnabled(true); setCallCameraEnabled(true); const activeCall = { kind, state: 'calling' as const, callId: crypto.randomUUID(), peerId: chat.userId, conversationId }; callRef.current = activeCall; setCallError(''); setCall(activeCall); socketRef.current.emit('call:invite', { conversationId, toUserId: chat.userId, callId: activeCall.callId, kind, fromName: session.user.display_name, fromUsername: session.user.username }) }
  const startCall = (kind: 'audio' | 'video') => { if (selectedChat) void beginCall(selectedChat, kind) }
  const sendTypingState = (chat: Chat, typing: boolean) => { const conversationId = conversationIdsRef.current[chat.id] || chat.conversationId; if (!conversationId || !socketRef.current) return; const existing = typingTimeoutsRef.current[chat.id]; if (existing) window.clearTimeout(existing); socketRef.current.emit(typing ? 'typing:start' : 'typing:stop', conversationId); if (typing) typingTimeoutsRef.current[chat.id] = window.setTimeout(() => { socketRef.current?.emit('typing:stop', conversationId); delete typingTimeoutsRef.current[chat.id] }, 1_200) }
  const ensureConversation = async (chat: Chat) => { if (!chat.userId) throw new Error('This contact is unavailable'); const existing = conversationIdsRef.current[chat.id] || conversationIds[chat.id] || chat.conversationId; if (existing) return existing; const created = await apiRequest<{ id: string }>(`/conversations/with/${chat.userId}`, { method: 'POST' }, session.token); conversationIdsRef.current = { ...conversationIdsRef.current, [chat.id]: created.id }; setConversationIds(prev => ({ ...prev, [chat.id]: created.id })); setConversations(prev => [{ id: created.id, created_at: new Date().toISOString(), participant: { id: chat.userId!, username: chat.handle.replace(/^@/, ''), display_name: chat.name }, last_message: null, unread_count: 0 }, ...prev.filter(item => item.id !== created.id)]); socketRef.current?.emit('conversation:join', created.id); return created.id }
  const sendMessage = async (chat: Chat, text: string) => { const conversationId = await ensureConversation(chat); const serverMessage = await apiRequest<ApiMessage>(`/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ body: text }) }, session.token); const next = apiMessageToMessage(serverMessage, session.user.id); setConversations(prev => prev.map(item => item.id === conversationId ? { ...item, last_message: serverMessage } : item)); setMessages(prev => prev[chat.id]?.some(message => message.id === next.id) ? prev : ({ ...prev, [chat.id]: [...(prev[chat.id] || []), next] })) }
  const uploadAttachment = async (chat: Chat, file: File, onProgress: (percent: number) => void) => { const conversationId = await ensureConversation(chat); const serverMessage = await uploadFile<ApiMessage>(`/conversations/${conversationId}/attachments`, file, session.token, onProgress); const next = apiMessageToMessage(serverMessage, session.user.id); setConversations(prev => prev.map(item => item.id === conversationId ? { ...item, last_message: serverMessage } : item)); setMessages(prev => prev[chat.id]?.some(message => message.id === next.id) ? prev : ({ ...prev, [chat.id]: [...(prev[chat.id] || []), next] })) }
  const searchContacts = (query: string) => { if (!query.trim()) { setSearchResults([]); return }; apiRequest<Contact[]>(`/contacts/search?q=${encodeURIComponent(query)}`, {}, session.token).then(setSearchResults).catch(() => setSearchResults([])) }
  const addContact = async (username: string) => { await apiRequest('/contacts/requests', { method: 'POST', body: JSON.stringify({ username }) }, session.token) }
  const acceptContact = async (requestId: string) => { await apiRequest(`/contacts/requests/${requestId}/accept`, { method: 'POST' }, session.token); const [contactResult, requestResult] = await Promise.all([apiRequest<Contact[]>('/contacts', {}, session.token), apiRequest<ContactRequest[]>('/contacts/requests', {}, session.token)]); setContacts(contactResult); setContactRequests(requestResult) }
  const openContact = (contact: Contact) => { setContacts(prev => prev.some(item => item.id === contact.id) ? prev : [...prev, contact]); setSelectedId(contact.id); setActiveNav('conversation') }
  const callContact = (contact: Contact, kind: 'audio' | 'video') => { const chat = contactToChat(contact, conversations.find(item => item.participant.id === contact.id), presenceByUserId[contact.id] || 'offline'); setContacts(prev => prev.some(item => item.id === contact.id) ? prev : [...prev, contact]); setSelectedId(contact.id); void beginCall(chat, kind) }
  const finishCall = () => { if (call) socketRef.current?.emit('call:end', { toUserId: call.peerId, callId: call.callId }); clearCallMedia(); callRef.current = null; setCall(null) }
  const toggleCallMic = () => { const enabled = !callMicEnabledRef.current; callMicEnabledRef.current = enabled; setCallMicEnabled(enabled); localStreamRef.current?.getAudioTracks().forEach(track => { track.enabled = enabled }) }
  const toggleCallCamera = () => { const enabled = !callCameraEnabledRef.current; callCameraEnabledRef.current = enabled; setCallCameraEnabled(enabled); const videoTrack = videoFilterPipelineRef.current?.track || localStreamRef.current?.getVideoTracks()[0]; if (videoTrack) videoTrack.enabled = enabled }
  const acceptCall = () => { if (!call) return; socketRef.current?.emit('call:accept', { toUserId: call.peerId, callId: call.callId }); callRef.current = { ...call, state: 'connected' }; setCall({ ...call, state: 'connected' }) }
  const logout = () => { localStorage.removeItem('contak-session'); setSession(null); setActiveNav('contacts'); setSelectedId(''); socketRef.current?.disconnect() }
  return <div className="app-shell"><Sidebar activeNav={activeNav} setActiveNav={setActiveNav} onOpenSettings={() => setActiveNav('settings')} user={session.user} /><div className="mobile-topbar"><div className="brand"><span className="brand-mark" /> <span>Contak<span className="brand-dot">.</span>App</span></div><button className="icon-btn"><Bell size={18} /></button></div>{activeNav === 'conversation' && selectedChat ? <div className="conversation-workspace"><Conversation chat={selectedChat} messages={messages[selectedChat.id] || []} setMessages={setMessages} onSend={sendMessage} onUpload={uploadAttachment} token={session.token} onTyping={sendTypingState} typing={Boolean(typingByChatId[selectedChat.id])} onCall={startCall} onBack={() => setActiveNav('contacts')} /><UtilityRail chat={selectedChat} onCall={startCall} /></div> : activeNav === 'contacts' ? <div className="content-view"><ContactsView contacts={contacts} searchResults={searchResults} requests={contactRequests} onSearch={searchContacts} onAdd={addContact} onAccept={acceptContact} onOpen={openContact} onCall={callContact} /></div> : activeNav === 'calls' ? <div className="content-view"><CallsView token={session.token} onOpenContact={openContact} /></div> : activeNav === 'settings' ? <div className="content-view"><SettingsView user={session.user} token={session.token} onLogout={logout} /></div> : <div className="content-view"><PlaceholderView activeNav={activeNav} /></div>}<div className="mobile-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={activeNav === id ? 'active' : ''} onClick={() => setActiveNav(id)}><Icon size={19} /><span>{label}</span></button>)}</div>{call && selectedChat && <CallOverlay chat={selectedChat} kind={call.kind} state={call.state} onAccept={acceptCall} onDecline={finishCall} onCancel={finishCall} mediaRef={remoteMediaRef} localMediaRef={localMediaRef} audioRef={remoteAudioRef} error={callError} filterId={callFilterId} onFilterChange={setCallFilterId} micEnabled={callMicEnabled} cameraEnabled={callCameraEnabled} onToggleMic={toggleCallMic} onToggleCamera={toggleCallCamera} />}</div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}
