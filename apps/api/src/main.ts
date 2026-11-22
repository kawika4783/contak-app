import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { Body, CanActivate, Controller, ExecutionContext, Get, Injectable, Module, Param, Post, Query, Req, UnauthorizedException, BadRequestException, ForbiddenException, UseGuards, ValidationPipe } from '@nestjs/common'
import { WebSocketGateway, WebSocketServer, SubscribeMessage, ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, WsException } from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { Pool } from 'pg'
import Redis from 'ioredis'
import bcrypt from 'bcryptjs'
import jwt, { JwtPayload } from 'jsonwebtoken'
import type { Request } from 'express'
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator'

const JWT_SECRET = process.env.JWT_SECRET || 'development-only-secret'
const TOKEN_TTL = '7d'
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

function issueToken(userId: string) { return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL }) }
function userFromToken(token?: string) { if (!token) return null; try { const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload; return typeof decoded.sub === 'string' ? decoded.sub : null } catch { return null } }

@Injectable()
class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>()
    const userId = userFromToken(request.headers.authorization?.replace(/^Bearer\s+/i, ''))
    if (!userId) throw new UnauthorizedException('A valid bearer token is required')
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
class MessageDto { @IsString() @MinLength(1) body!: string }
class ContactRequestDto { @IsString() username!: string }

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
  @Get('me') async me(@Req() req: AuthRequest) { const userId = req.userId!; const result = await this.db.query('SELECT id, username, display_name, email, role, created_at FROM users WHERE id = $1', [userId]); return result.rows[0] }
}

@Controller('api/contacts')
@UseGuards(AuthGuard)
class ContactsController {
  constructor(private readonly db: DbService) {}
  @Get('search') async search(@Req() req: AuthRequest, @Query('q') q = '') { const result = await this.db.query('SELECT id, username, display_name FROM users WHERE id <> $1 AND (username ILIKE $2 OR display_name ILIKE $2) ORDER BY username LIMIT 20', [req.userId!, `%${q.trim()}%`]); return result.rows }
  @Get() async list(@Req() req: AuthRequest) { const result = await this.db.query('SELECT u.id, u.username, u.display_name, c.favorite FROM contacts c JOIN users u ON u.id = c.contact_user_id WHERE c.user_id = $1 ORDER BY c.favorite DESC, u.display_name', [req.userId!]); return result.rows }
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
  broadcastMessage(conversationId: string, message: unknown) { this.server.to(conversationId).emit('message:new', message) }
}

@Controller('api/conversations')
@UseGuards(AuthGuard)
class ConversationsController {
  constructor(private readonly db: DbService, private readonly realtime: RealtimeGateway) {}
  private async assertParticipant(conversationId: string, userId: string) { const result = await this.db.query('SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]); if (!result.rowCount) throw new UnauthorizedException('Conversation access denied') }
  @Get() async list(@Req() req: AuthRequest) { const result = await this.db.query('SELECT c.id, c.created_at, json_agg(json_build_object(\'id\', u.id, \'username\', u.username, \'displayName\', u.display_name)) FILTER (WHERE u.id <> $1) AS participants FROM conversations c JOIN conversation_participants cp ON cp.conversation_id = c.id JOIN users u ON u.id = cp.user_id WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE user_id = $1) GROUP BY c.id ORDER BY c.created_at DESC', [req.userId!]); return result.rows }
  @Post('with/:userId') async withUser(@Req() req: AuthRequest, @Param('userId') userId: string) { const existing = await this.db.query('SELECT c.id FROM conversations c JOIN conversation_participants a ON a.conversation_id = c.id AND a.user_id = $1 JOIN conversation_participants b ON b.conversation_id = c.id AND b.user_id = $2 WHERE (SELECT count(*) FROM conversation_participants x WHERE x.conversation_id = c.id) = 2 LIMIT 1', [req.userId!, userId]); if (existing.rows[0]) return { id: existing.rows[0].id }; const created = await this.db.query('INSERT INTO conversations DEFAULT VALUES RETURNING id'); const id = created.rows[0].id; await this.db.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)', [id, req.userId!, userId]); return { id } }
  @Get(':id/messages') async messages(@Req() req: AuthRequest, @Param('id') id: string, @Query('limit') limit = '50') { await this.assertParticipant(id, req.userId!); const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100); const result = await this.db.query('SELECT m.id, m.conversation_id, m.body, m.created_at, m.sender_id, u.username, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2', [id, safeLimit]); return result.rows.reverse() }
  @Post(':id/messages') async send(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: MessageDto) { await this.assertParticipant(id, req.userId!); const created = await this.db.query('INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at, sender_id', [id, req.userId!, body.body.trim()]); const result = await this.db.query('SELECT m.id, m.conversation_id, m.body, m.created_at, m.sender_id, u.username, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1', [created.rows[0].id]); const message = result.rows[0]; this.realtime.broadcastMessage(id, message); return message }
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
    const result = await this.db.query("SELECT u.id, u.username, u.display_name, u.role, u.created_at, COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.sender_id = u.id), u.created_at) AS last_active, (SELECT count(*)::int FROM messages m WHERE m.sender_id = u.id) AS messages_count FROM users u WHERE u.username ILIKE $1 OR u.display_name ILIKE $1 ORDER BY last_active DESC LIMIT $2 OFFSET $3", [search, safeLimit, safeOffset])
    const total = await this.db.query('SELECT count(*)::int AS count FROM users WHERE username ILIKE $1 OR display_name ILIKE $1', [search])
    return { users: result.rows, total: total.rows[0].count, limit: safeLimit, offset: safeOffset }
  }
  @Get('activity') async activity() {
    const result = await this.db.query("SELECT 'New user' AS type, display_name AS subject, '@' || username AS detail, created_at FROM users ORDER BY created_at DESC LIMIT 8")
    return result.rows
  }
}

@Module({ controllers: [HealthController, AuthController, ContactsController, ConversationsController, AdminController], providers: [DbService, PresenceService, AuthGuard, AdminGuard, RealtimeGateway] })
class AppModule {}

async function bootstrap() { const app = await NestFactory.create(AppModule); app.enableCors({ origin: true, credentials: true }); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.listen(Number(process.env.PORT || 3000), '0.0.0.0') }
bootstrap()
