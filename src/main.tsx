import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Bell, Camera, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, Edit3, FileText,
  Hash, Heart, Image, Inbox, LayoutGrid, Mic, MoreVertical, Paperclip, Phone, Play,
  Plus, Search, Send, Settings, ShieldCheck, Smile, Sparkles, UserRoundPlus, UsersRound,
  Video, Volume2, X, Zap,
} from 'lucide-react'
import './styles.css'

type Chat = { id: string; name: string; handle: string; initials: string; color: string; status: 'online' | 'away' | 'busy' | 'offline'; time: string; preview: string; unread?: number; avatar: string }
type Message = { id: number; from: 'me' | 'them'; text: string; time: string; read?: boolean; reaction?: string }

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

function Sidebar({ activeNav, setActiveNav }: { activeNav: string; setActiveNav: (id: string) => void }) {
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark" /> <span>Contak<span className="brand-dot">.</span>App</span></div>
    <nav className="primary-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={activeNav === id ? 'active' : ''} onClick={() => setActiveNav(id)}><Icon size={20} /><span>{label}</span>{id === 'calls' && <em>2</em>}</button>)}</nav>
    <div className="sidebar-spacer" />
    <div className="sidebar-mini-card"><Sparkles size={15} /><div><strong>Midnight Glass</strong><span>Everything feels connected.</span></div></div>
    <div className="profile-mini"><div className="avatar sm"><span>KW</span><i className="presence online" /></div><div><strong>Kawika</strong><span>Available</span></div><MoreVertical size={17} /></div>
  </aside>
}

function ChatList({ selectedId, setSelectedId, onNew }: { selectedId: string; setSelectedId: (id: string) => void; onNew: () => void }) {
  return <section className="chat-list">
    <div className="list-heading"><div><p className="eyebrow">Your space</p><h1>Messages</h1></div><button className="icon-btn" onClick={onNew} aria-label="New message"><Edit3 size={17} /></button></div>
    <div className="search-field"><Search size={16} /><input placeholder="Search chats..." aria-label="Search chats" /></div>
    <div className="chat-list-scroll">{chats.map(chat => <button key={chat.id} className={`chat-row ${selectedId === chat.id ? 'selected' : ''}`} onClick={() => setSelectedId(chat.id)}><Avatar chat={chat} /><span className="chat-row-copy"><strong>{chat.name}</strong><span>{chat.preview}</span></span><span className="chat-row-meta"><time>{chat.time}</time>{chat.unread ? <b>{chat.unread}</b> : chat.id !== 'alex' && <CheckCheck size={14} />}</span></button>)}</div>
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

function Conversation({ chat, messages, setMessages, onCall }: { chat: Chat; messages: Message[]; setMessages: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>; onCall: (kind: 'audio' | 'video') => void }) {
  const [draft, setDraft] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, isTyping])
  const send = () => { const value = draft.trim(); if (!value) return; setMessages(prev => ({ ...prev, [chat.id]: [...(prev[chat.id] || []), { id: Date.now(), from: 'me', text: value, time: 'Now', read: false }] })); setDraft(''); setIsTyping(false) }
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

function SettingsView() {
  const [ringtonePlaying, setRingtonePlaying] = useState(false)
  return <div className="settings-view"><div className="settings-heading"><p className="eyebrow">Control center</p><h1>Settings</h1><p>Shape your Contak.App experience.</p></div><div className="settings-grid"><section className="settings-card"><div className="settings-card-heading"><div className="settings-icon violet"><Bell size={17} /></div><div><h3>Call & notification sounds</h3><p>Make every call feel unmistakably yours.</p></div></div><div className="setting-row"><div><strong>Default ringtone</strong><span>Incoming calls on this device</span></div><RingtonePreview active={ringtonePlaying} onToggle={() => setRingtonePlaying(value => !value)} /></div><div className="setting-row"><div><strong>Vibration</strong><span>Use haptics for incoming calls</span></div><button className="toggle on"><span /></button></div><div className="setting-row"><div><strong>Do Not Disturb</strong><span>Pause notifications until you turn it off</span></div><button className="toggle"><span /></button></div></section><section className="settings-card"><div className="settings-card-heading"><div className="settings-icon blue"><ShieldCheck size={17} /></div><div><h3>Privacy</h3><p>Keep your presence and conversations yours.</p></div></div><div className="setting-row"><div><strong>Show online status</strong><span>Let contacts see when you’re around</span></div><button className="toggle on"><span /></button></div><div className="setting-row"><div><strong>Read receipts</strong><span>Show when you’ve read messages</span></div><button className="toggle on"><span /></button></div></section></div></div>
}

function PlaceholderView({ activeNav }: { activeNav: string }) { const nav = navItems.find(item => item.id === activeNav); const Icon = nav?.icon || LayoutGrid; return <div className="empty-view"><div className="empty-icon"><Icon size={28} /></div><h1>{nav?.label || 'Workspace'}</h1><p>This space is ready for the next phase of your private communication stack.</p><button className="primary-btn"><Zap size={17} />Explore {nav?.label}</button></div> }

function App() {
  const [activeNav, setActiveNav] = useState('chats'); const [selectedId, setSelectedId] = useState('alex'); const [messages, setMessages] = useState(seedMessages); const [call, setCall] = useState<{ kind: 'audio' | 'video'; state: 'incoming' | 'calling' | 'connected' } | null>({ kind: 'audio', state: 'incoming' });
  const selectedChat = useMemo(() => chats.find(chat => chat.id === selectedId) || chats[0], [selectedId])
  const startCall = (kind: 'audio' | 'video') => setCall({ kind, state: 'calling' })
  return <div className="app-shell"><Sidebar activeNav={activeNav} setActiveNav={setActiveNav} /><div className="mobile-topbar"><div className="brand"><span className="brand-mark" /> <span>Contak<span className="brand-dot">.</span>App</span></div><button className="icon-btn"><Bell size={18} /></button></div>{activeNav === 'chats' ? <><ChatList selectedId={selectedId} setSelectedId={setSelectedId} onNew={() => setSelectedId('priya')} /><Conversation chat={selectedChat} messages={messages[selectedId] || []} setMessages={setMessages} onCall={startCall} /><UtilityRail chat={selectedChat} onCall={startCall} /></> : <div className="content-view"><PlaceholderView activeNav={activeNav} /></div>}<div className="mobile-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={activeNav === id ? 'active' : ''} onClick={() => setActiveNav(id)}><Icon size={19} /><span>{label}</span></button>)}</div>{call && <CallOverlay chat={selectedChat.id === 'alex' ? chats[1] : selectedChat} kind={call.kind} state={call.state} onAccept={() => setCall({ ...call, state: 'connected' })} onDecline={() => setCall(null)} onCancel={() => setCall(null)} />}</div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}
