import 'reflect-metadata'
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { Body, CanActivate, Controller, ExecutionContext, Get, Injectable, Module, Param, Post, Query, Req, UnauthorizedException, BadRequestException, ForbiddenException, StreamableFile, UploadedFile, UseGuards, UseInterceptors, ValidationPipe } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { WebSocketGateway, WebSocketServer, SubscribeMessage, ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, WsException } from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { Pool } from 'pg'
import Redis from 'ioredis'
import bcrypt from 'bcryptjs'
import jwt, { JwtPayload } from 'jsonwebtoken'
import webpush from 'web-push'
import type { Request } from 'express'
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator'

const JWT_SECRET = process.env.JWT_SECRET || 'development-only-secret'
const TOKEN_TTL = '7d'
const UPLOAD_DIR = join(process.cwd(), 'uploads')
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf', 'text/plain', 'text/csv', 'application/json',
  'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])
mkdirSync(UPLOAD_DIR, { recursive: true })
type AuthRequest = Request & { userId?: string }

@Injectable()
class DbService {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://contak:contak@localhost:5432/contak', max: 10, idleTimeoutMillis: 30_000 })

  async onModuleInit() {
    const schema = readFileSync(join(process.cwd(), 'schema.sql'), 'utf8')
    await this.pool.query(schema)
    await this.ensureAdmin()
  }

  private async ensureAdmin() {
    const username = process.env.ADMIN_USERNAME
    const email = process.env.ADMIN_EMAIL
    const password = process.env.ADMIN_PASSWORD
    if (!username || !email || !password) return
    const passwordHash = await bcrypt.hash(password, 12)
    await this.pool.query('INSERT INTO users (username, display_name, email, password_hash, role) VALUES ($1, $2, $3, $4, \'admin\') ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, role = \'admin\'', [username.toLowerCase(), 'Contak Administrator', email.toLowerCase(), passwordHash])
  }

  query(text: string, values: unknown[] = []) { return this.pool.query(text, values) }
}

@Injectable()
class PresenceService {
  private readonly redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 })
  async touch(userId: string) { try { if (this.redis.status === 'wait') await this.redis.connect(); await this.redis.set(`presence:${userId}`, 'online', 'EX', 65) } catch { /* presence is ephemeral and must never block messaging */ } }
  async offline(userId: string) { try { await this.redis.del(`presence:${userId}`) } catch { /* best effort */ } }
}

type NotificationMode = 'on' | 'silent' | 'off'

@Injectable()
class PushService {
  readonly publicKey = process.env.VAPID_PUBLIC_KEY || ''
  private readonly enabled = Boolean(this.publicKey && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT)
  constructor(private readonly db: DbService) {
    if (this.enabled) webpush.setVapidDetails(process.env.VAPID_SUBJECT!, this.publicKey, process.env.VAPID_PRIVATE_KEY!)
  }
  async notifyMessage(conversationId: string, message: { id: string; sender_id: string; display_name: string; body: string; attachment?: { name?: string } | null }) {
    if (!this.enabled) return
    try {
      const recipients = await this.db.query(`SELECT ps.endpoint, ps.subscription, COALESCE(np.mode, 'on') AS mode FROM conversation_participants cp JOIN push_subscriptions ps ON ps.user_id = cp.user_id LEFT JOIN notification_preferences np ON np.user_id = cp.user_id WHERE cp.conversation_id = $1 AND cp.user_id <> $2`, [conversationId, message.sender_id])
      const body = message.attachment?.name ? `Sent an attachment: ${message.attachment.name}` : message.body
      await Promise.all(recipients.rows.filter(row => row.mode !== 'off').map(async row => {
        try {
          await webpush.sendNotification(row.subscription, JSON.stringify({ title: message.display_name, body, silent: row.mode === 'silent', tag: `contak-message-${conversationId}`, url: '/' }), { TTL: 60 })
        } catch (error: any) {
          if (error?.statusCode === 404 || error?.statusCode === 410) await this.db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint])
        }
      }))
    } catch { /* push delivery must never block message delivery */ }
  }
}

function issueToken(userId: string) { return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL }) }
function userFromToken(token?: string) { if (!token) return null; try { const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload; return typeof decoded.sub === 'string' ? decoded.sub : null } catch { return null } }

@Injectable()
class AuthGuard implements CanActivate {
  constructor(private readonly db: DbService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>()
    const userId = userFromToken(request.headers.authorization?.replace(/^Bearer\s+/i, ''))
    if (!userId) throw new UnauthorizedException('A valid bearer token is required')
    const result = await this.db.query('SELECT suspended_until FROM users WHERE id = $1', [userId])
    if (result.rows[0]?.suspended_until && new Date(result.rows[0].suspended_until).getTime() > Date.now()) throw new ForbiddenException('This account is temporarily restricted')
    request.userId = userId
    return true
  }
}

@Injectable()
class AdminGuard implements CanActivate {
  constructor(private readonly db: DbService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>()
    const userId = userFromToken(request.headers.authorization?.replace(/^Bearer\s+/i, ''))
    if (!userId) throw new UnauthorizedException('A valid bearer token is required')
    const result = await this.db.query('SELECT role FROM users WHERE id = $1', [userId])
    if (result.rows[0]?.role !== 'admin') throw new ForbiddenException('Administrator access is required')
    request.userId = userId
    return true
  }
}

class RegisterDto { @IsString() @MinLength(3) username!: string; @IsString() @MinLength(2) displayName!: string; @IsEmail() email!: string; @IsString() @MinLength(8) password!: string }
class LoginDto { @IsString() username!: string; @IsString() password!: string }
class ChangePasswordDto { @IsString() currentPassword!: string; @IsString() @MinLength(8) newPassword!: string }
class MessageDto { @IsString() @MinLength(1) body!: string }
class ContactRequestDto { @IsString() username!: string }

type UploadedChatFile = { originalname: string; mimetype: string; size: number; path: string }

@Controller('api/health')
class HealthController {
  constructor(private readonly db: DbService) {}
  @Get() async health() { await this.db.query('SELECT 1'); return { ok: true, service: 'contak-api' } }
}

@Controller('api/auth')
class AuthController {
  constructor(private readonly db: DbService) {}
  @Post('register') async register(@Body() body: RegisterDto) {
    const username = body.username.trim().toLowerCase()
    const passwordHash = await bcrypt.hash(body.password, 12)
    try {
      const result = await this.db.query('INSERT INTO users (username, display_name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, username, display_name, email, role, created_at', [username, body.displayName.trim(), body.email.trim().toLowerCase(), passwordHash])
      const user = result.rows[0]
      return { user, token: issueToken(user.id) }
    } catch (error: any) { if (error.code === '23505') throw new BadRequestException('Username or email is already registered'); throw error }
  }
  @Post('login') async login(@Body() body: LoginDto) {
    const result = await this.db.query('SELECT id, username, display_name, email, password_hash, role, created_at FROM users WHERE username = $1', [body.username.trim().toLowerCase()])
    const user = result.rows[0]
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) throw new UnauthorizedException('Invalid username or password')
    const { password_hash: _, ...safeUser } = user
    return { user: safeUser, token: issueToken(user.id) }
  }
  @UseGuards(AuthGuard)
  @Post('password') async changePassword(@Req() req: AuthRequest, @Body() body: ChangePasswordDto) {
    const result = await this.db.query('SELECT password_hash FROM users WHERE id = $1', [req.userId!])
    const user = result.rows[0]
    if (!user || !(await bcrypt.compare(body.currentPassword, user.password_hash))) throw new UnauthorizedException('Current password is incorrect')
    if (body.currentPassword === body.newPassword) throw new BadRequestException('New password must be different')
    const passwordHash = await bcrypt.hash(body.newPassword, 12)
    await this.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, req.userId!])
    return { ok: true }
  }
  @UseGuards(AuthGuard)
  @Get('me') async me(@Req() req: AuthRequest) { const userId = req.userId!; const result = await this.db.query('SELECT id, username, display_name, email, role, created_at FROM users WHERE id = $1', [userId]); return result.rows[0] }
}

@Controller('api/contacts')
@UseGuards(AuthGuard)
class ContactsController {
  constructor(private readonly db: DbService) {}
  @Get('search') async search(@Req() req: AuthRequest, @Query('q') q = '') { const result = await this.db.query('SELECT id, username, display_name FROM users WHERE id <> $1 AND (username ILIKE $2 OR display_name ILIKE $2) ORDER BY username LIMIT 20', [req.userId!, `%${q.trim()}%`]); return result.rows }
  @Get() async list(@Req() req: AuthRequest) { const result = await this.db.query('SELECT u.id, u.username, u.display_name, c.favorite FROM contacts c JOIN users u ON u.id = c.contact_user_id WHERE c.user_id = $1 ORDER BY c.favorite DESC, u.display_name', [req.userId!]); return result.rows }
  @Get('requests') async requests(@Req() req: AuthRequest) { const result = await this.db.query('SELECT r.id, u.username, u.display_name, r.created_at FROM contact_requests r JOIN users u ON u.id = r.from_user_id WHERE r.to_user_id = $1 AND r.status = \'pending\' ORDER BY r.created_at DESC', [req.userId!]); return result.rows }
  @Post('requests') async request(@Req() req: AuthRequest, @Body() body: ContactRequestDto) { const target = await this.db.query('SELECT id FROM users WHERE username = $1', [body.username.trim().toLowerCase()]); if (!target.rows[0] || target.rows[0].id === req.userId) throw new BadRequestException('Contact not found'); const result = await this.db.query('INSERT INTO contact_requests (from_user_id, to_user_id) VALUES ($1, $2) ON CONFLICT (from_user_id, to_user_id) DO UPDATE SET status = \'pending\' RETURNING id, status, created_at', [req.userId!, target.rows[0].id]); return result.rows[0] }
  @Post('requests/:id/accept') async accept(@Req() req: AuthRequest, @Param('id') id: string) { const request = await this.db.query('UPDATE contact_requests SET status = \'accepted\' WHERE id = $1 AND to_user_id = $2 AND status = \'pending\' RETURNING from_user_id, to_user_id', [id, req.userId!]); if (!request.rows[0]) throw new BadRequestException('Request is unavailable'); const { from_user_id: from, to_user_id: to } = request.rows[0]; await this.db.query('INSERT INTO contacts (user_id, contact_user_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [from, to]); return { ok: true } }
}

@WebSocketGateway({ cors: { origin: true, credentials: true } })
class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server
  private readonly sockets = new Map<string, Set<string>>()
  constructor(private readonly db: DbService, private readonly presence: PresenceService) {}
  async handleConnection(socket: Socket) { const userId = userFromToken(socket.handshake.auth?.token); if (!userId) return socket.disconnect(true); socket.data.userId = userId; const set = this.sockets.get(userId) || new Set<string>(); set.add(socket.id); this.sockets.set(userId, set); await this.presence.touch(userId); socket.emit('session:ready', { userId }); this.server.emit('presence:update', { userId, status: 'online' }) }
  async handleDisconnect(socket: Socket) { const userId = socket.data.userId as string | undefined; if (!userId) return; const set = this.sockets.get(userId); set?.delete(socket.id); if (!set?.size) { this.sockets.delete(userId); await this.presence.offline(userId); this.server.emit('presence:update', { userId, status: 'offline' }) } }
  @SubscribeMessage('presence:heartbeat') async heartbeat(@ConnectedSocket() socket: Socket) { if (socket.data.userId) await this.presence.touch(socket.data.userId); return { ok: true } }
  @SubscribeMessage('conversation:join') async join(@ConnectedSocket() socket: Socket, @MessageBody() conversationId: string) { const userId = socket.data.userId as string; const result = await this.db.query('SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]); if (!result.rowCount) throw new WsException('Conversation access denied'); await socket.join(conversationId); return { ok: true } }
  @SubscribeMessage('typing:start') typingStart(@ConnectedSocket() socket: Socket, @MessageBody() conversationId: string) { socket.to(conversationId).emit('typing:update', { conversationId, userId: socket.data.userId, status: 'typing' }); return { ok: true } }
  @SubscribeMessage('typing:stop') typingStop(@ConnectedSocket() socket: Socket, @MessageBody() conversationId: string) { socket.to(conversationId).emit('typing:update', { conversationId, userId: socket.data.userId, status: 'idle' }); return { ok: true } }
  private emitToUser(userId: string, event: string, payload: unknown) { this.sockets.get(userId)?.forEach(socketId => this.server.to(socketId).emit(event, payload)) }
  @SubscribeMessage('call:invite') async callInvite(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId: string; toUserId: string; callId: string; kind: 'audio' | 'video'; fromName?: string; fromUsername?: string }) { const userId = socket.data.userId as string; const result = await this.db.query('SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id IN ($2, $3)', [body.conversationId, userId, body.toUserId]); if (result.rowCount !== 2) throw new WsException('Call participant access denied'); await this.db.query('INSERT INTO call_history (id, caller_id, recipient_id, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [body.callId, userId, body.toUserId, body.kind]); this.emitToUser(body.toUserId, 'call:incoming', { conversationId: body.conversationId, callId: body.callId, kind: body.kind, fromUserId: userId, fromName: body.fromName, fromUsername: body.fromUsername }); return { ok: true } }
  @SubscribeMessage('call:accept') async callAccept(@ConnectedSocket() socket: Socket, @MessageBody() body: { toUserId: string; callId: string }) { await this.db.query("UPDATE call_history SET status = 'answered', answered_at = now() WHERE id = $1 AND (caller_id = $2 OR recipient_id = $2)", [body.callId, socket.data.userId]); this.emitToUser(body.toUserId, 'call:accepted', { callId: body.callId, fromUserId: socket.data.userId }); return { ok: true } }
  @SubscribeMessage('call:end') async callEnd(@ConnectedSocket() socket: Socket, @MessageBody() body: { toUserId: string; callId: string }) { await this.db.query("UPDATE call_history SET status = CASE WHEN status = 'calling' THEN 'missed' ELSE 'ended' END, ended_at = now() WHERE id = $1 AND (caller_id = $2 OR recipient_id = $2)", [body.callId, socket.data.userId]); this.emitToUser(body.toUserId, 'call:ended', { callId: body.callId, fromUserId: socket.data.userId }); return { ok: true } }
  @SubscribeMessage('call:signal') callSignal(@ConnectedSocket() socket: Socket, @MessageBody() body: { toUserId: string; callId: string; signal: unknown }) { this.emitToUser(body.toUserId, 'call:signal', { callId: body.callId, fromUserId: socket.data.userId, signal: body.signal }); return { ok: true } }
  broadcastMessage(conversationId: string, message: unknown) { this.server.to(conversationId).emit('message:new', message) }
  broadcastRead(conversationId: string, userId: string) { this.server.to(conversationId).emit('receipt:read', { conversationId, userId }) }
}

@Controller('api/calls')
@UseGuards(AuthGuard)
class CallsController {
  constructor(private readonly db: DbService) {}
  @Get('history') async history(@Req() req: AuthRequest) {
    const result = await this.db.query(`
      SELECT ch.id, ch.kind, ch.status, ch.created_at, ch.answered_at, ch.ended_at,
        CASE WHEN ch.caller_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction,
        other.id AS user_id, other.username, other.display_name
      FROM call_history ch
      JOIN users other ON other.id = CASE WHEN ch.caller_id = $1 THEN ch.recipient_id ELSE ch.caller_id END
      WHERE ch.caller_id = $1 OR ch.recipient_id = $1
      ORDER BY ch.created_at DESC
      LIMIT 50
    `, [req.userId!])
    return result.rows
  }
  @Get('ice') iceServers() {
    const host = process.env.TURN_HOST || 'contak-app.srv1831469.hstgr.cloud'
    const port = process.env.TURN_PORT || '3479'
    const username = process.env.TURN_USERNAME || ''
    const credential = process.env.TURN_PASSWORD || ''
    return {
      iceServers: [
        { urls: [`stun:${host}:${port}`] },
        ...(username && credential ? [{ urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`], username, credential }] : []),
      ],
    }
  }
}

@Controller('api/conversations')
@UseGuards(AuthGuard)
class ConversationsController {
  constructor(private readonly db: DbService, private readonly realtime: RealtimeGateway, private readonly push: PushService) {}
  private async assertParticipant(conversationId: string, userId: string) { const result = await this.db.query('SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]); if (!result.rowCount) throw new UnauthorizedException('Conversation access denied') }
  @Get() async list(@Req() req: AuthRequest) {
    const result = await this.db.query(`
      SELECT c.id, c.created_at,
        other_user.id AS participant_id,
        other_user.username AS participant_username,
        other_user.display_name AS participant_display_name,
        last_message.id AS last_message_id,
        last_message.body AS last_message_body,
        last_message.created_at AS last_message_created_at,
        last_message.sender_id AS last_message_sender_id,
        COALESCE((SELECT count(*)::int FROM messages unread_message LEFT JOIN message_receipts unread_receipt ON unread_receipt.message_id = unread_message.id AND unread_receipt.user_id = $1 WHERE unread_message.conversation_id = c.id AND unread_message.sender_id <> $1 AND unread_receipt.read_at IS NULL), 0) AS unread_count
      FROM conversations c
      JOIN conversation_participants mine ON mine.conversation_id = c.id AND mine.user_id = $1
      JOIN conversation_participants other_participant ON other_participant.conversation_id = c.id AND other_participant.user_id <> $1
      JOIN users other_user ON other_user.id = other_participant.user_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.body, m.created_at, m.sender_id
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ) last_message ON true
      ORDER BY COALESCE(last_message.created_at, c.created_at) DESC
    `, [req.userId!])
    return result.rows.map(row => ({
      id: row.id,
      created_at: row.created_at,
      participant: { id: row.participant_id, username: row.participant_username, display_name: row.participant_display_name },
      last_message: row.last_message_id ? { id: row.last_message_id, conversation_id: row.id, body: row.last_message_body, created_at: row.last_message_created_at, sender_id: row.last_message_sender_id } : null,
      unread_count: row.unread_count,
    }))
  }
  @Post('with/:userId') async withUser(@Req() req: AuthRequest, @Param('userId') userId: string) { const existing = await this.db.query('SELECT c.id FROM conversations c JOIN conversation_participants a ON a.conversation_id = c.id AND a.user_id = $1 JOIN conversation_participants b ON b.conversation_id = c.id AND b.user_id = $2 WHERE (SELECT count(*) FROM conversation_participants x WHERE x.conversation_id = c.id) = 2 LIMIT 1', [req.userId!, userId]); if (existing.rows[0]) return { id: existing.rows[0].id }; const created = await this.db.query('INSERT INTO conversations DEFAULT VALUES RETURNING id'); const id = created.rows[0].id; await this.db.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)', [id, req.userId!, userId]); return { id } }
  private async markRead(conversationId: string, userId: string) {
    const result = await this.db.query(`
      INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at)
      SELECT m.id, $2, now(), now()
      FROM messages m
      WHERE m.conversation_id = $1 AND m.sender_id <> $2
      ON CONFLICT (message_id, user_id) DO UPDATE
      SET delivered_at = COALESCE(message_receipts.delivered_at, now()), read_at = COALESCE(message_receipts.read_at, now())
      RETURNING message_id
    `, [conversationId, userId])
    if (result.rowCount) this.realtime.broadcastRead(conversationId, userId)
  }
  @Post(':id/read') async read(@Req() req: AuthRequest, @Param('id') id: string) { await this.assertParticipant(id, req.userId!); await this.markRead(id, req.userId!); return { ok: true } }
  private toMessage(row: any) {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      body: row.body,
      created_at: row.created_at,
      sender_id: row.sender_id,
      username: row.username,
      display_name: row.display_name,
      read: row.read,
      attachment: row.attachment_path ? { url: `/api/conversations/${row.conversation_id}/attachments/${row.id}`, name: row.attachment_name, mime: row.attachment_mime, size: row.attachment_size } : null,
    }
  }
  private readonly messageFields = `m.id, m.conversation_id, m.body, m.created_at, m.sender_id, m.message_type, m.attachment_path, m.attachment_name, m.attachment_mime, m.attachment_size, u.username, u.display_name`
  @Get(':id/messages') async messages(@Req() req: AuthRequest, @Param('id') id: string, @Query('limit') limit = '50') { await this.assertParticipant(id, req.userId!); await this.markRead(id, req.userId!); const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100); const result = await this.db.query(`SELECT ${this.messageFields}, EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id = m.id AND mr.user_id <> m.sender_id AND mr.read_at IS NOT NULL) AS read FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2`, [id, safeLimit]); return result.rows.reverse().map(row => this.toMessage(row)) }
  @Post(':id/messages') async send(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: MessageDto) { await this.assertParticipant(id, req.userId!); const created = await this.db.query('INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at, sender_id', [id, req.userId!, body.body.trim()]); await this.db.query('INSERT INTO message_receipts (message_id, user_id, delivered_at) SELECT $1, cp.user_id, now() FROM conversation_participants cp WHERE cp.conversation_id = $2 AND cp.user_id <> $3 ON CONFLICT DO NOTHING', [created.rows[0].id, id, req.userId!]); const result = await this.db.query(`SELECT ${this.messageFields}, false AS read FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, [created.rows[0].id]); const message = this.toMessage(result.rows[0]); this.realtime.broadcastMessage(id, message); void this.push.notifyMessage(id, message); return message }
  @UseInterceptors(FileInterceptor('file', { dest: UPLOAD_DIR, limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @Post(':id/attachments') async upload(@Req() req: AuthRequest, @Param('id') id: string, @UploadedFile() file?: UploadedChatFile) {
    await this.assertParticipant(id, req.userId!)
    if (!file) throw new BadRequestException('Choose a file to send')
    if (!ALLOWED_UPLOAD_TYPES.has(file.mimetype)) {
      if (existsSync(file.path)) unlinkSync(file.path)
      throw new BadRequestException('This file type is not supported')
    }
    const fileName = basename(file.originalname).slice(0, 255) || 'Attachment'
    const messageType = file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('video/') ? 'video' : 'file'
    const created = await this.db.query('INSERT INTO messages (conversation_id, sender_id, body, message_type, attachment_path, attachment_name, attachment_mime, attachment_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', [id, req.userId!, fileName, messageType, file.path, fileName, file.mimetype, file.size])
    await this.db.query('INSERT INTO message_receipts (message_id, user_id, delivered_at) SELECT $1, cp.user_id, now() FROM conversation_participants cp WHERE cp.conversation_id = $2 AND cp.user_id <> $3 ON CONFLICT DO NOTHING', [created.rows[0].id, id, req.userId!])
    const result = await this.db.query(`SELECT ${this.messageFields}, false AS read FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, [created.rows[0].id])
    const message = this.toMessage(result.rows[0]); this.realtime.broadcastMessage(id, message); void this.push.notifyMessage(id, message); return message
  }
  @Get(':id/attachments/:messageId') async attachment(@Req() req: AuthRequest, @Param('id') id: string, @Param('messageId') messageId: string) {
    await this.assertParticipant(id, req.userId!)
    const result = await this.db.query('SELECT attachment_path, attachment_name, attachment_mime FROM messages WHERE id = $1 AND conversation_id = $2 AND attachment_path IS NOT NULL', [messageId, id])
    const file = result.rows[0]
    if (!file || !existsSync(file.attachment_path)) throw new BadRequestException('Attachment is no longer available')
    const safeName = basename(file.attachment_name || 'attachment').replace(/["\r\n]/g, '_')
    return new StreamableFile(createReadStream(file.attachment_path), { type: file.attachment_mime, disposition: `inline; filename="${safeName}"` })
  }
}

@Controller('api/notifications')
@UseGuards(AuthGuard)
class NotificationsController {
  constructor(private readonly db: DbService, private readonly push: PushService) {}
  @Get('config') config() { return { publicKey: this.push.publicKey } }
  @Get('preferences') async preferences(@Req() req: AuthRequest) { const result = await this.db.query('SELECT mode FROM notification_preferences WHERE user_id = $1', [req.userId!]); return { mode: (result.rows[0]?.mode || 'off') as NotificationMode } }
  @Post('preferences') async updatePreferences(@Req() req: AuthRequest, @Body() body: { mode?: NotificationMode }) {
    if (!body.mode || !['on', 'silent', 'off'].includes(body.mode)) throw new BadRequestException('Notification mode must be on, silent, or off')
    await this.db.query('INSERT INTO notification_preferences (user_id, mode) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()', [req.userId!, body.mode])
    return { mode: body.mode }
  }
  @Post('subscribe') async subscribe(@Req() req: AuthRequest, @Body() body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }) {
    if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) throw new BadRequestException('Invalid push subscription')
    await this.db.query('INSERT INTO push_subscriptions (endpoint, user_id, subscription, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription, updated_at = now()', [body.endpoint, req.userId!, JSON.stringify(body)])
    return { ok: true }
  }
  @Post('unsubscribe') async unsubscribe(@Req() req: AuthRequest, @Body() body: { endpoint?: string }) { if (body.endpoint) await this.db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [body.endpoint, req.userId!]); return { ok: true } }
}

@Controller('api/admin')
@UseGuards(AdminGuard)
class AdminController {
  constructor(private readonly db: DbService) {}
  @Get('overview') async overview() {
    const [users, activeUsers, conversations, messages] = await Promise.all([
      this.db.query('SELECT count(*)::int AS count FROM users'),
      this.db.query("SELECT count(*)::int AS count FROM users WHERE created_at > now() - interval '24 hours'"),
      this.db.query("SELECT count(*)::int AS count FROM conversations WHERE created_at > date_trunc('day', now())"),
      this.db.query("SELECT count(*)::int AS count FROM messages WHERE created_at > date_trunc('day', now())"),
    ])
    return { totalUsers: users.rows[0].count, activeUsers: activeUsers.rows[0].count, conversationsToday: conversations.rows[0].count, messagesToday: messages.rows[0].count, apiHealth: 'Healthy' }
  }
  @Get('users') async listUsers(@Query('limit') limit = '8', @Query('offset') offset = '0', @Query('q') query = '') {
    const safeLimit = Math.min(Math.max(Number(limit) || 8, 1), 50); const safeOffset = Math.max(Number(offset) || 0, 0); const search = `%${query.trim()}%`
    const result = await this.db.query("SELECT u.id, u.username, u.display_name, u.role, u.suspended_until, u.suspension_reason, u.created_at, COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.sender_id = u.id), u.created_at) AS last_active, (SELECT count(*)::int FROM messages m WHERE m.sender_id = u.id) AS messages_count FROM users u WHERE u.username ILIKE $1 OR u.display_name ILIKE $1 ORDER BY last_active DESC LIMIT $2 OFFSET $3", [search, safeLimit, safeOffset])
    const total = await this.db.query('SELECT count(*)::int AS count FROM users WHERE username ILIKE $1 OR display_name ILIKE $1', [search])
    return { users: result.rows, total: total.rows[0].count, limit: safeLimit, offset: safeOffset }
  }
  @Get('activity') async activity() {
    const result = await this.db.query("SELECT 'New user' AS type, display_name AS subject, '@' || username AS detail, created_at FROM users ORDER BY created_at DESC LIMIT 8")
    return result.rows
  }
  @Get('reports') async reports(@Query('status') status = 'open') {
    const result = await this.db.query("SELECT r.id, r.reason, r.details, r.status, r.created_at, r.resolved_at, reporter.username AS reporter_username, reported.username AS reported_username, reported.display_name AS reported_display_name FROM reports r JOIN users reporter ON reporter.id = r.reporter_id JOIN users reported ON reported.id = r.reported_user_id WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 50", [status])
    return result.rows
  }
  @Post('reports/:id/resolve') async resolveReport(@Param('id') id: string, @Body() body: { status?: 'resolved' | 'dismissed' }) {
    const status = body.status === 'dismissed' ? 'dismissed' : 'resolved'
    const result = await this.db.query('UPDATE reports SET status = $1, resolved_at = now() WHERE id = $2 RETURNING id, status, resolved_at', [status, id])
    if (!result.rows[0]) throw new BadRequestException('Report not found')
    return result.rows[0]
  }
  @Post('users/:id/restrict') async restrictUser(@Param('id') id: string, @Body() body: { reason?: string; hours?: number }) {
    const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 720); const reason = (body.reason || 'Policy review').trim().slice(0, 255)
    const result = await this.db.query("UPDATE users SET suspended_until = now() + ($1 || ' hours')::interval, suspension_reason = $2 WHERE id = $3 AND role <> 'admin' RETURNING id, username, suspended_until, suspension_reason", [hours, reason, id])
    if (!result.rows[0]) throw new BadRequestException('User not found or cannot be restricted')
    return result.rows[0]
  }
  @Post('users/:id/unrestrict') async unrestrictUser(@Param('id') id: string) {
    const result = await this.db.query('UPDATE users SET suspended_until = NULL, suspension_reason = NULL WHERE id = $1 RETURNING id, username', [id])
    if (!result.rows[0]) throw new BadRequestException('User not found')
    return result.rows[0]
  }
  @Get('system') async system() {
    await this.db.query('SELECT 1')
    return { api: 'Healthy', database: 'Healthy', realtime: 'Healthy', version: '0.1.0', uptimeSeconds: Math.round(process.uptime()), environment: process.env.NODE_ENV || 'production' }
  }
  @Get('conversations') async conversations() {
    const [total, today, messagesToday, recent] = await Promise.all([
      this.db.query('SELECT count(*)::int AS count FROM conversations'),
      this.db.query("SELECT count(*)::int AS count FROM conversations WHERE created_at > date_trunc('day', now())"),
      this.db.query("SELECT count(*)::int AS count FROM messages WHERE created_at > date_trunc('day', now())"),
      this.db.query("SELECT c.id, c.created_at, count(DISTINCT m.id)::int AS messages_count, string_agg(DISTINCT u.display_name, ' · ') AS participants FROM conversations c JOIN conversation_participants cp ON cp.conversation_id = c.id JOIN users u ON u.id = cp.user_id LEFT JOIN messages m ON m.conversation_id = c.id GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50"),
    ])
    return { total: total.rows[0].count, today: today.rows[0].count, messagesToday: messagesToday.rows[0].count, recent: recent.rows }
  }
}

@Module({ controllers: [HealthController, AuthController, ContactsController, CallsController, ConversationsController, NotificationsController, AdminController], providers: [DbService, PresenceService, PushService, AuthGuard, AdminGuard, RealtimeGateway] })
class AppModule {}

async function bootstrap() { const app = await NestFactory.create(AppModule); app.enableCors({ origin: true, credentials: true }); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.listen(Number(process.env.PORT || 3000), '0.0.0.0') }
bootstrap()
