import 'reflect-metadata'
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { Body, CanActivate, Controller, ExecutionContext, Get, HttpException, HttpStatus, Injectable, Module, OnModuleDestroy, OnModuleInit, Param, Patch, Post, Query, Req, UnauthorizedException, BadRequestException, ForbiddenException, NotFoundException, StreamableFile, UploadedFile, UseGuards, UseInterceptors, ValidationPipe } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { WebSocketGateway, WebSocketServer, SubscribeMessage, ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, WsException } from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { Pool } from 'pg'
import Redis from 'ioredis'
import bcrypt from 'bcryptjs'
import jwt, { JwtPayload } from 'jsonwebtoken'
import webpush from 'web-push'
import sharp from 'sharp'
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
const PROFILE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const PROFILE_IMAGE_MAX_BYTES = 8 * 1024 * 1024
const PRESENCE_STATUSES = new Set(['online', 'offline', 'away', 'busy', 'dnd', 'invisible'])
mkdirSync(UPLOAD_DIR, { recursive: true })
type AuthRequest = Request & { userId?: string }
function profileImageUrl(path?: string | null) { return path ? `/api/profile/avatar/${encodeURIComponent(basename(path))}` : null }
function safeProfile(row: any) {
  return {
    id: row.id, username: row.username, display_name: row.display_name, email: row.email, role: row.role,
    phone: row.phone || null, hometown: row.hometown || null, about_me: row.about_me || null,
    profile_image_url: profileImageUrl(row.profile_image_path), profile_visibility: row.profile_visibility || 'private',
    search_by_email: Boolean(row.search_by_email), search_by_phone: Boolean(row.search_by_phone), search_by_name: Boolean(row.search_by_name),
    profile_updated_at: row.profile_updated_at || null,
  }
}

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
  async transaction<T>(work: (client: import('pg').PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}

@Injectable()
class PresenceService {
  private readonly redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 })
  async touch(userId: string) { try { if (this.redis.status === 'wait') await this.redis.connect(); const status = await this.redis.get(`presence:${userId}`) || 'online'; await this.redis.set(`presence:${userId}`, status, 'EX', 65) } catch { /* presence is ephemeral and must never block messaging */ } }
  async setStatus(userId: string, status: string) { try { if (this.redis.status === 'wait') await this.redis.connect(); await this.redis.set(`presence:${userId}`, status, 'EX', 65) } catch { /* best effort */ } }
  async statuses(userIds: string[]) { if (!userIds.length) return new Map<string, string>(); try { if (this.redis.status === 'wait') await this.redis.connect(); const values = await this.redis.mget(...userIds.map(id => `presence:${id}`)); return new Map(userIds.map((id, index) => [id, values[index] || 'offline'])) } catch { return new Map(userIds.map(id => [id, 'offline'])) } }
  async offline(userId: string) { try { await this.redis.del(`presence:${userId}`) } catch { /* best effort */ } }
}

@Injectable()
class RateLimitService {
  private readonly redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 })
  async check(key: string, limit: number, windowSeconds: number) {
    try {
      if (this.redis.status === 'wait') await this.redis.connect()
      const count = await this.redis.incr(`ratelimit:${key}`)
      if (count === 1) await this.redis.expire(`ratelimit:${key}`, windowSeconds)
      if (count > limit) throw new HttpException('Too many attempts. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS)
    } catch (error) { if (error instanceof HttpException) throw error }
  }
}

type NotificationMode = 'on' | 'silent' | 'off'

@Injectable()
class PushService {
  readonly publicKey = process.env.VAPID_PUBLIC_KEY || ''
  private readonly enabled = Boolean(this.publicKey && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT)
  constructor(private readonly db: DbService) {
    if (this.enabled) webpush.setVapidDetails(process.env.VAPID_SUBJECT!, this.publicKey, process.env.VAPID_PRIVATE_KEY!)
  }
  async notifyMessage(conversationId: string, message: { id: string; sender_id: string; display_name: string; body: string; attachment?: { name?: string; ephemeral?: unknown } | null }) {
    if (!this.enabled) return
    try {
      const recipients = await this.db.query(`SELECT ps.endpoint, ps.subscription, COALESCE(np.mode, 'on') AS mode FROM conversation_participants cp JOIN push_subscriptions ps ON ps.user_id = cp.user_id LEFT JOIN notification_preferences np ON np.user_id = cp.user_id WHERE cp.conversation_id = $1 AND cp.user_id <> $2`, [conversationId, message.sender_id])
      const body = message.attachment?.ephemeral ? 'Sent a View Once photo' : message.attachment?.name ? `Sent an attachment: ${message.attachment.name}` : message.body
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
class ProfileUpdateDto {
  @IsOptional() @IsString() displayName?: string
  @IsOptional() @IsEmail() email?: string
  @IsOptional() @IsString() phone?: string
  @IsOptional() @IsString() hometown?: string
  @IsOptional() @IsString() aboutMe?: string
  @IsOptional() @IsString() profileVisibility?: 'private' | 'public'
  @IsOptional() searchByEmail?: boolean
  @IsOptional() searchByPhone?: boolean
  @IsOptional() searchByName?: boolean
}

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
      return { user: safeProfile(user), token: issueToken(user.id) }
    } catch (error: any) { if (error.code === '23505') throw new BadRequestException('Username or email is already registered'); throw error }
  }
  @Post('login') async login(@Body() body: LoginDto) {
    const result = await this.db.query('SELECT id, username, display_name, email, password_hash, role, phone, hometown, about_me, profile_image_path, profile_visibility, search_by_email, search_by_phone, search_by_name, profile_updated_at FROM users WHERE username = $1', [body.username.trim().toLowerCase()])
    const user = result.rows[0]
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) throw new UnauthorizedException('Invalid username or password')
    return { user: safeProfile(user), token: issueToken(user.id) }
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
  @Get('me') async me(@Req() req: AuthRequest) { const userId = req.userId!; const result = await this.db.query('SELECT id, username, display_name, email, role, phone, hometown, about_me, profile_image_path, profile_visibility, search_by_email, search_by_phone, search_by_name, profile_updated_at FROM users WHERE id = $1', [userId]); return safeProfile(result.rows[0]) }
}

@Controller('api/profile')
class ProfileController {
  constructor(private readonly db: DbService) {}
  @UseGuards(AuthGuard)
  @Get() async current(@Req() req: AuthRequest) {
    const result = await this.db.query('SELECT id, username, display_name, email, role, phone, hometown, about_me, profile_image_path, profile_visibility, search_by_email, search_by_phone, search_by_name, profile_updated_at FROM users WHERE id = $1', [req.userId!])
    if (!result.rows[0]) throw new NotFoundException('Profile not found')
    return safeProfile(result.rows[0])
  }
  @UseGuards(AuthGuard)
  @Patch() async update(@Req() req: AuthRequest, @Body() body: ProfileUpdateDto) {
    const visibility = body.profileVisibility === 'public' ? 'public' : 'private'
    const result = await this.db.query(`UPDATE users SET display_name = COALESCE(NULLIF($2, ''), display_name), email = COALESCE(NULLIF($3, ''), email), phone = NULLIF($4, ''), hometown = NULLIF($5, ''), about_me = NULLIF($6, ''), profile_visibility = $7::varchar, search_by_email = CASE WHEN $7::varchar = 'public' THEN COALESCE($8::boolean, false) ELSE false END, search_by_phone = CASE WHEN $7::varchar = 'public' THEN COALESCE($9::boolean, false) ELSE false END, search_by_name = CASE WHEN $7::varchar = 'public' THEN COALESCE($10::boolean, false) ELSE false END, profile_updated_at = now() WHERE id = $1 RETURNING id, username, display_name, email, role, phone, hometown, about_me, profile_image_path, profile_visibility, search_by_email, search_by_phone, search_by_name, profile_updated_at`, [req.userId!, body.displayName?.trim(), body.email?.trim().toLowerCase(), body.phone?.trim(), body.hometown?.trim(), body.aboutMe?.trim(), visibility, body.searchByEmail, body.searchByPhone, body.searchByName])
    if (!result.rows[0]) throw new NotFoundException('Profile not found')
    return safeProfile(result.rows[0])
  }
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('file', { dest: UPLOAD_DIR, limits: { fileSize: PROFILE_IMAGE_MAX_BYTES } }))
  @Post('avatar') async avatar(@Req() req: AuthRequest, @UploadedFile() file?: UploadedChatFile) {
    if (!file) throw new BadRequestException('Choose an image to upload')
    if (!PROFILE_IMAGE_TYPES.has(file.mimetype)) { if (existsSync(file.path)) unlinkSync(file.path); throw new BadRequestException('Profile photos must be JPG, PNG, WEBP, or GIF') }
    const storedPath = join(UPLOAD_DIR, `profile-${randomUUID()}-${basename(file.originalname).replace(/[^a-z0-9._-]/gi, '_')}`)
    const { renameSync } = await import('node:fs')
    renameSync(file.path, storedPath)
    const result = await this.db.query('UPDATE users SET profile_image_path = $2, profile_updated_at = now() WHERE id = $1 RETURNING id, username, display_name, email, role, phone, hometown, about_me, profile_image_path, profile_visibility, search_by_email, search_by_phone, search_by_name, profile_updated_at', [req.userId!, storedPath])
    return safeProfile(result.rows[0])
  }
  @Get('public/:username') async publicProfile(@Req() req: AuthRequest, @Param('username') username: string) {
    const viewerId = userFromToken(req.headers.authorization?.replace(/^Bearer\s+/i, ''))
    const result = await this.db.query('SELECT id, username, display_name, email, phone, hometown, about_me, profile_image_path, profile_visibility, search_by_email, search_by_phone FROM users WHERE username = $1 AND (profile_visibility = \'public\' OR id = $2)', [username.trim().toLowerCase(), viewerId])
    const profile = result.rows[0]
    if (!profile) throw new NotFoundException('This profile is private or unavailable')
    return { id: profile.id, username: profile.username, display_name: profile.display_name, profile_image_url: profileImageUrl(profile.profile_image_path), hometown: profile.hometown || null, about_me: profile.about_me || null, email: profile.search_by_email ? profile.email : null, phone: profile.search_by_phone ? profile.phone : null }
  }
  @Get('avatar/:fileName') async avatarFile(@Param('fileName') fileName: string) {
    const safeName = basename(fileName)
    const result = await this.db.query('SELECT profile_image_path FROM users WHERE profile_image_path = $1', [join(UPLOAD_DIR, safeName)])
    const path = result.rows[0]?.profile_image_path
    if (!path || !existsSync(path)) throw new NotFoundException('Profile image is unavailable')
    return new StreamableFile(createReadStream(path))
  }
}

@Controller('api/presence')
@UseGuards(AuthGuard)
class PresenceController {
  constructor(private readonly db: DbService, private readonly presence: PresenceService) {}
  @Get() async current(@Req() req: AuthRequest) {
    const result = await this.db.query('SELECT presence_status, presence_visibility FROM users WHERE id = $1', [req.userId!])
    return { status: result.rows[0]?.presence_status || 'online', visibility: result.rows[0]?.presence_visibility || 'contacts' }
  }
  @Post() async update(@Req() req: AuthRequest, @Body() body: { status?: string; visibility?: string }) {
    const status = PRESENCE_STATUSES.has(body.status || '') ? body.status : 'online'
    const visibility = ['everyone', 'contacts', 'nobody'].includes(body.visibility || '') ? body.visibility : 'contacts'
    const result = await this.db.query('UPDATE users SET presence_status = $2, presence_visibility = $3 WHERE id = $1 RETURNING presence_status, presence_visibility', [req.userId!, status, visibility])
    await this.presence.setStatus(req.userId!, status!)
    return { status: result.rows[0].presence_status, visibility: result.rows[0].presence_visibility }
  }
}

@Controller('api/contacts')
@UseGuards(AuthGuard)
class ContactsController {
  constructor(private readonly db: DbService, private readonly presence: PresenceService) {}
  @Get('search') async search(@Req() req: AuthRequest, @Query('q') q = '') { const term = q.trim(); const result = await this.db.query(`SELECT u.id, u.username, u.display_name, u.profile_image_path FROM users u WHERE u.id <> $1 AND u.profile_visibility = 'public' AND (u.username ILIKE $2 OR (u.search_by_name AND u.display_name ILIKE $2) OR (u.search_by_email AND u.email ILIKE $2) OR (u.search_by_phone AND regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g') <> '' AND regexp_replace(u.phone, '\\D', '', 'g') ILIKE '%' || regexp_replace($3, '\\D', '', 'g') || '%')) ORDER BY u.username LIMIT 20`, [req.userId!, `%${term}%`, term]); return result.rows.map(row => ({ id: row.id, username: row.username, display_name: row.display_name, profile_image_url: profileImageUrl(row.profile_image_path) })) }
  @Get() async list(@Req() req: AuthRequest) { const result = await this.db.query('SELECT u.id, u.username, u.display_name, u.profile_image_path, u.presence_visibility, c.favorite, c.favorite_order, c.nickname FROM contacts c JOIN users u ON u.id = c.contact_user_id WHERE c.user_id = $1 ORDER BY c.favorite DESC, c.favorite_order ASC, u.display_name', [req.userId!]); const statuses = await this.presence.statuses(result.rows.map(row => row.id)); return result.rows.map(row => ({ id: row.id, username: row.username, display_name: row.display_name, nickname: row.nickname || null, profile_image_url: profileImageUrl(row.profile_image_path), favorite: row.favorite, favorite_order: row.favorite_order, presence: row.presence_visibility === 'nobody' ? 'offline' : (statuses.get(row.id) || 'offline') })) }
  @Get('requests') async requests(@Req() req: AuthRequest) { const result = await this.db.query('SELECT r.id, u.username, u.display_name, r.created_at FROM contact_requests r JOIN users u ON u.id = r.from_user_id WHERE r.to_user_id = $1 AND r.status = \'pending\' ORDER BY r.created_at DESC', [req.userId!]); return result.rows }
  @Post('requests') async request(@Req() req: AuthRequest, @Body() body: ContactRequestDto) { const target = await this.db.query('SELECT id FROM users WHERE username = $1', [body.username.trim().toLowerCase()]); if (!target.rows[0] || target.rows[0].id === req.userId) throw new BadRequestException('Contact not found'); const result = await this.db.query('INSERT INTO contact_requests (from_user_id, to_user_id) VALUES ($1, $2) ON CONFLICT (from_user_id, to_user_id) DO UPDATE SET status = \'pending\' RETURNING id, status, created_at', [req.userId!, target.rows[0].id]); return result.rows[0] }
  @Post('requests/:id/accept') async accept(@Req() req: AuthRequest, @Param('id') id: string) { const request = await this.db.query('UPDATE contact_requests SET status = \'accepted\' WHERE id = $1 AND to_user_id = $2 AND status = \'pending\' RETURNING from_user_id, to_user_id', [id, req.userId!]); if (!request.rows[0]) throw new BadRequestException('Request is unavailable'); const { from_user_id: from, to_user_id: to } = request.rows[0]; await this.db.query('INSERT INTO contacts (user_id, contact_user_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [from, to]); return { ok: true } }
  @Patch(':id') async updateContact(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: { favorite?: boolean; favorite_order?: number; nickname?: string | null }) {
    const result = await this.db.query('UPDATE contacts SET favorite = COALESCE($3::boolean, favorite), favorite_order = COALESCE($4::int, favorite_order), nickname = CASE WHEN $5::text IS NULL THEN nickname ELSE NULLIF(left($5::text, 80), \'\') END WHERE user_id = $1 AND contact_user_id = $2 RETURNING favorite, favorite_order, nickname', [req.userId!, id, body.favorite, body.favorite_order, body.nickname])
    if (!result.rows[0]) throw new NotFoundException('Contact not found')
    return result.rows[0]
  }
}

function removeFile(path?: string | null) { if (path && existsSync(path)) { try { unlinkSync(path) } catch { /* cleanup is retried by the worker */ } } }

@Injectable()
class EphemeralCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout
  constructor(private readonly db: DbService) {}
  onModuleInit() { this.timer = setInterval(() => void this.run(), 5 * 60_000); void this.run() }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer) }
  async run() {
    try {
      const expired = await this.db.query(`UPDATE ephemeral_media SET state = 'expired', cleanup_attempts = cleanup_attempts + 1, last_cleanup_error = NULL WHERE media_path IS NOT NULL AND ((state = 'unopened' AND unopened_expires_at <= now()) OR (state = 'viewing' AND session_expires_at <= now())) RETURNING message_id, media_path`, [])
      for (const row of expired.rows) { removeFile(row.media_path); await this.db.query('UPDATE ephemeral_media SET media_path = NULL WHERE message_id = $1 AND state = \'expired\'', [row.message_id]) }
    } catch { /* a later interval retries cleanup; message delivery is unaffected */ }
  }
}

@WebSocketGateway({ cors: { origin: true, credentials: true } })
class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server
  private readonly sockets = new Map<string, Set<string>>()
  constructor(private readonly db: DbService, private readonly presence: PresenceService) {}
  async handleConnection(socket: Socket) { const userId = userFromToken(socket.handshake.auth?.token); if (!userId) return socket.disconnect(true); socket.data.userId = userId; const set = this.sockets.get(userId) || new Set<string>(); set.add(socket.id); this.sockets.set(userId, set); await this.presence.touch(userId); socket.emit('session:ready', { userId }); this.server.emit('presence:update', { userId, status: 'online' }) }
  async handleDisconnect(socket: Socket) { const userId = socket.data.userId as string | undefined; if (!userId) return; const set = this.sockets.get(userId); set?.delete(socket.id); if (!set?.size) { this.sockets.delete(userId); await this.presence.offline(userId); this.server.emit('presence:update', { userId, status: 'offline' }) } }
  @SubscribeMessage('presence:heartbeat') async heartbeat(@ConnectedSocket() socket: Socket) { if (socket.data.userId) await this.presence.touch(socket.data.userId); return { ok: true } }
  @SubscribeMessage('presence:set') async setPresence(@ConnectedSocket() socket: Socket, @MessageBody() body: { status?: string }) { const status = PRESENCE_STATUSES.has(body.status || '') ? body.status! : 'online'; await this.db.query('UPDATE users SET presence_status = $2 WHERE id = $1', [socket.data.userId, status]); await this.presence.setStatus(socket.data.userId, status); this.server.emit('presence:update', { userId: socket.data.userId, status }); return { ok: true, status } }
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
  constructor(private readonly db: DbService, private readonly realtime: RealtimeGateway, private readonly push: PushService, private readonly rateLimit: RateLimitService) {}
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
    const attachment = row.ephemeral_id ? { url: null, name: row.attachment_name, mime: row.attachment_mime, size: row.attachment_size, ephemeral: { state: row.ephemeral_state, durationSeconds: row.ephemeral_duration_seconds || 0 } } : row.attachment_path ? { url: `/api/conversations/${row.conversation_id}/attachments/${row.id}`, name: row.attachment_name, mime: row.attachment_mime, size: row.attachment_size } : null
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      body: row.body,
      created_at: row.created_at,
      sender_id: row.sender_id,
      username: row.username,
      display_name: row.display_name,
      read: row.read,
      attachment,
    }
  }
  private readonly messageFields = `m.id, m.conversation_id, m.body, m.created_at, m.sender_id, m.message_type, m.attachment_path, m.attachment_name, m.attachment_mime, m.attachment_size, u.username, u.display_name, e.message_id AS ephemeral_id, e.state AS ephemeral_state, e.view_duration_seconds AS ephemeral_duration_seconds`
  private readonly messageJoin = `FROM messages m JOIN users u ON u.id = m.sender_id LEFT JOIN ephemeral_media e ON e.message_id = m.id`
  @Get(':id/messages') async messages(@Req() req: AuthRequest, @Param('id') id: string, @Query('limit') limit = '50') { await this.assertParticipant(id, req.userId!); await this.markRead(id, req.userId!); const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100); const result = await this.db.query(`SELECT ${this.messageFields}, EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id = m.id AND mr.user_id <> m.sender_id AND mr.read_at IS NOT NULL) AS read ${this.messageJoin} WHERE m.conversation_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2`, [id, safeLimit]); return result.rows.reverse().map(row => this.toMessage(row)) }
  @Post(':id/messages') async send(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: MessageDto) { await this.assertParticipant(id, req.userId!); const created = await this.db.query('INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at, sender_id', [id, req.userId!, body.body.trim()]); await this.db.query('INSERT INTO message_receipts (message_id, user_id, delivered_at) SELECT $1, cp.user_id, now() FROM conversation_participants cp WHERE cp.conversation_id = $2 AND cp.user_id <> $3 ON CONFLICT DO NOTHING', [created.rows[0].id, id, req.userId!]); const result = await this.db.query(`SELECT ${this.messageFields}, false AS read ${this.messageJoin} WHERE m.id = $1`, [created.rows[0].id]); const message = this.toMessage(result.rows[0]); this.realtime.broadcastMessage(id, message); void this.push.notifyMessage(id, message); return message }
  @UseInterceptors(FileInterceptor('file', { dest: UPLOAD_DIR, limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @Post(':id/attachments') async upload(@Req() req: AuthRequest, @Param('id') id: string, @Body() fields: { viewOnce?: string; viewDurationSeconds?: string }, @UploadedFile() file?: UploadedChatFile) {
    await this.assertParticipant(id, req.userId!)
    if (!file) throw new BadRequestException('Choose a file to send')
    if (!ALLOWED_UPLOAD_TYPES.has(file.mimetype)) {
      if (existsSync(file.path)) unlinkSync(file.path)
      throw new BadRequestException('This file type is not supported')
    }
    const wantsViewOnce = fields.viewOnce === 'true'
    const settingsResult = wantsViewOnce ? await this.db.query('SELECT * FROM admin_ephemeral_settings WHERE id = true') : null
    const settings = settingsResult?.rows[0]
    if (wantsViewOnce && (!settings?.enabled || !file.mimetype.startsWith('image/') || !settings.allowed_image_formats.includes(file.mimetype) || file.size > settings.max_image_bytes)) { removeFile(file.path); throw new BadRequestException('View Once is available for supported images within the configured size limit') }
    const durationSeconds = wantsViewOnce ? Number(fields.viewDurationSeconds || 0) : 0
    if (wantsViewOnce && (!settings.allowed_durations.includes(durationSeconds) || (durationSeconds > 0 && !settings.timed_viewing_enabled))) { removeFile(file.path); throw new BadRequestException('That View Once duration is not available') }
    let storedPath = file.path
    let storedMime = file.mimetype
    let storedSize = file.size
    if (wantsViewOnce) {
      try {
        const sanitized = await sharp(file.path).rotate().webp({ quality: 90 }).toBuffer()
        storedPath = join(UPLOAD_DIR, `ephemeral-${randomUUID()}.webp`)
        writeFileSync(storedPath, sanitized)
        storedMime = 'image/webp'
        storedSize = sanitized.byteLength
        removeFile(file.path)
      } catch { removeFile(file.path); throw new BadRequestException('The image could not be prepared securely') }
    }
    const fileName = basename(file.originalname).slice(0, 255) || 'Attachment'
    const messageType = file.mimetype.startsWith('image/') ? 'image' : file.mimetype.startsWith('video/') ? 'video' : 'file'
    const created = await this.db.query('INSERT INTO messages (conversation_id, sender_id, body, message_type, attachment_path, attachment_name, attachment_mime, attachment_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', [id, req.userId!, fileName, messageType, storedPath, fileName, storedMime, storedSize])
    const recipient = await this.db.query('SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id <> $2 LIMIT 1', [id, req.userId!])
    if (wantsViewOnce) await this.db.query('INSERT INTO ephemeral_media (message_id, sender_id, recipient_id, media_path, original_name, media_mime, media_size, view_duration_seconds, unopened_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || \' hours\')::interval)', [created.rows[0].id, req.userId!, recipient.rows[0]?.user_id, storedPath, fileName, storedMime, storedSize, durationSeconds, settings.unopened_expiry_hours])
    await this.db.query('INSERT INTO message_receipts (message_id, user_id, delivered_at) SELECT $1, cp.user_id, now() FROM conversation_participants cp WHERE cp.conversation_id = $2 AND cp.user_id <> $3 ON CONFLICT DO NOTHING', [created.rows[0].id, id, req.userId!])
    const result = await this.db.query(`SELECT ${this.messageFields}, false AS read ${this.messageJoin} WHERE m.id = $1`, [created.rows[0].id])
    const message = this.toMessage(result.rows[0]); this.realtime.broadcastMessage(id, message); void this.push.notifyMessage(id, message); return message
  }
  @Get(':id/attachments/:messageId') async attachment(@Req() req: AuthRequest, @Param('id') id: string, @Param('messageId') messageId: string) {
    await this.assertParticipant(id, req.userId!)
    const result = await this.db.query('SELECT m.attachment_path, m.attachment_name, m.attachment_mime FROM messages m LEFT JOIN ephemeral_media e ON e.message_id = m.id WHERE m.id = $1 AND m.conversation_id = $2 AND m.attachment_path IS NOT NULL AND e.message_id IS NULL', [messageId, id])
    const file = result.rows[0]
    if (!file || !existsSync(file.attachment_path)) throw new BadRequestException('Attachment is no longer available')
    const safeName = basename(file.attachment_name || 'attachment').replace(/["\r\n]/g, '_')
    return new StreamableFile(createReadStream(file.attachment_path), { type: file.attachment_mime, disposition: `inline; filename="${safeName}"` })
  }
  @Post(':id/view-once/:messageId/claim') async claimViewOnce(@Req() req: AuthRequest, @Param('id') id: string, @Param('messageId') messageId: string) {
    await this.assertParticipant(id, req.userId!)
    await this.rateLimit.check(`${req.userId!}:${messageId}`, 10, 60)
    const settings = (await this.db.query('SELECT max_session_seconds FROM admin_ephemeral_settings WHERE id = true')).rows[0]
    const token = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const sessionId = randomUUID()
    const claimed = await this.db.transaction(async client => {
      const result = await client.query(`UPDATE ephemeral_media SET state = 'viewing', viewing_session_hash = $1, session_started_at = now(), session_expires_at = now() + ($2 || ' seconds')::interval WHERE message_id = $3 AND recipient_id = $4 AND state = 'unopened' AND unopened_expires_at > now() RETURNING original_name, media_mime, media_size, view_duration_seconds, session_expires_at`, [tokenHash, Math.min(Number(settings?.max_session_seconds) || 300, 900), messageId, req.userId!])
      return result.rows[0]
    })
    if (!claimed) throw new BadRequestException('This View Once photo has already been opened or expired')
    return { sessionId, sessionToken: token, contentPath: `/api/conversations/${id}/view-once/${messageId}/content`, name: claimed.original_name, mime: claimed.media_mime, size: claimed.media_size, durationSeconds: claimed.view_duration_seconds, expiresAt: claimed.session_expires_at }
  }
  @Get(':id/view-once/:messageId/content') async viewOnceContent(@Req() req: AuthRequest, @Param('id') id: string, @Param('messageId') messageId: string) {
    await this.assertParticipant(id, req.userId!)
    const sessionToken = req.headers['x-view-once-session']
    if (typeof sessionToken !== 'string' || sessionToken.length < 32) throw new UnauthorizedException('A View Once session is required')
    const tokenHash = createHash('sha256').update(sessionToken).digest('hex')
    const result = await this.db.query('SELECT media_path, original_name, media_mime FROM ephemeral_media WHERE message_id = $1 AND recipient_id = $2 AND state = \'viewing\' AND viewing_session_hash = $3 AND session_expires_at > now()', [messageId, req.userId!, tokenHash])
    const file = result.rows[0]
    if (!file || !file.media_path || !existsSync(file.media_path)) throw new BadRequestException('This View Once session has expired')
    const safeName = basename(file.original_name || 'view-once.webp').replace(/["\r\n]/g, '_')
    req.res?.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    req.res?.setHeader('Pragma', 'no-cache')
    req.res?.setHeader('X-Content-Type-Options', 'nosniff')
    return new StreamableFile(createReadStream(file.media_path), { type: file.media_mime, disposition: `inline; filename="${safeName}"` })
  }
  @Post(':id/view-once/:messageId/close') async closeViewOnce(@Req() req: AuthRequest, @Param('id') id: string, @Param('messageId') messageId: string, @Body() body: { sessionToken?: string }) {
    await this.assertParticipant(id, req.userId!)
    if (!body.sessionToken) throw new UnauthorizedException('A View Once session is required')
    const tokenHash = createHash('sha256').update(body.sessionToken).digest('hex')
    const result = await this.db.query("UPDATE ephemeral_media SET state = 'opened', viewed_at = COALESCE(viewed_at, now()), viewing_session_hash = NULL, session_expires_at = NULL WHERE message_id = $1 AND recipient_id = $2 AND state = 'viewing' AND viewing_session_hash = $3 RETURNING media_path", [messageId, req.userId!, tokenHash])
    if (!result.rows[0]) throw new BadRequestException('This View Once session is no longer active')
    removeFile(result.rows[0].media_path)
    await this.db.query("UPDATE ephemeral_media SET media_path = NULL WHERE message_id = $1 AND state = 'opened'", [messageId])
    return { ok: true, state: 'opened' }
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
  @Get('ephemeral-settings') async ephemeralSettings() { const result = await this.db.query('SELECT * FROM admin_ephemeral_settings WHERE id = true'); return result.rows[0] }
  @Patch('ephemeral-settings') async updateEphemeralSettings(@Body() body: Record<string, unknown>) {
    const current = (await this.db.query('SELECT * FROM admin_ephemeral_settings WHERE id = true')).rows[0]
    const bool = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback
    const int = (value: unknown, fallback: number, min: number, max: number) => Math.min(Math.max(Number(value) || fallback, min), max)
    const allowedDurations = Array.isArray(body.allowedDurations) ? body.allowedDurations.map(Number).filter(value => [0, 5, 10, 30].includes(value)) : current.allowed_durations
    const result = await this.db.query(`UPDATE admin_ephemeral_settings SET enabled = $2, timed_viewing_enabled = $3, allowed_durations = $4::int[], max_image_bytes = $5, unopened_expiry_hours = $6, max_session_seconds = $7, cleanup_interval_seconds = $8, storage_limit_bytes = $9, claim_rate_limit = $10, updated_at = now() WHERE id = true RETURNING *`, [true, bool(body.enabled, current.enabled), bool(body.timedViewingEnabled, current.timed_viewing_enabled), allowedDurations, int(body.maxImageBytes, current.max_image_bytes, 1_048_576, 100 * 1_024 * 1_024), int(body.unopenedExpiryHours, current.unopened_expiry_hours, 1, 8_760), int(body.maxSessionSeconds, current.max_session_seconds, 5, 900), int(body.cleanupIntervalSeconds, current.cleanup_interval_seconds, 60, 86_400), int(body.storageLimitBytes, current.storage_limit_bytes, 1_048_576, 1_099_511_627_776), int(body.claimRateLimit, current.claim_rate_limit, 1, 100)])
    return result.rows[0]
  }
  @Get('ephemeral-stats') async ephemeralStats() {
    const [states, storage, errors] = await Promise.all([
      this.db.query('SELECT state, count(*)::int AS count FROM ephemeral_media GROUP BY state ORDER BY state'),
      this.db.query("SELECT COALESCE(sum(media_size), 0)::bigint AS bytes FROM ephemeral_media WHERE media_path IS NOT NULL"),
      this.db.query("SELECT count(*)::int AS count FROM ephemeral_media WHERE last_cleanup_error IS NOT NULL"),
    ])
    return { states: states.rows, storageBytes: Number(storage.rows[0].bytes), cleanupErrors: errors.rows[0].count }
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

@Module({ controllers: [HealthController, AuthController, ProfileController, PresenceController, ContactsController, CallsController, ConversationsController, NotificationsController, AdminController], providers: [DbService, PresenceService, RateLimitService, EphemeralCleanupService, PushService, AuthGuard, AdminGuard, RealtimeGateway] })
class AppModule {}

async function bootstrap() { const app = await NestFactory.create(AppModule); app.enableCors({ origin: true, credentials: true }); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.listen(Number(process.env.PORT || 3000), '0.0.0.0') }
bootstrap()
