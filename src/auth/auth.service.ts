import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../crypto/crypto.util';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import { users } from '../database/schema';
import type { ConsentRequestMeta } from '../legal/legal.service';
import { LegalService } from '../legal/legal.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import type { JwtPayload } from './jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly jwt: JwtService,
    private readonly legal: LegalService,
  ) {}

  private token(id: string, email: string): string {
    const payload: JwtPayload = { sub: id, email };
    return this.jwt.sign(payload);
  }

  /**
   * Create an account. `dto.acceptedTerms` is required to be true by the DTO,
   * and the consent rows are written in the same transaction as the user, so
   * an account can never exist without the acceptance that created it.
   */
  async register(dto: RegisterDto, meta: ConsentRequestMeta = {}) {
    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, dto.email.toLowerCase()))
      .limit(1);
    if (existing) throw new ConflictException('Email already registered');

    const user = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          email: dto.email.toLowerCase(),
          passwordHash: hashPassword(dto.password),
          name: dto.name,
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          plan: users.plan,
          role: users.role,
        });

      await this.legal.record({
        userId: row.id,
        context: 'registration',
        acceptedDocuments: dto.acceptedDocuments,
        meta,
        exec: tx,
      });

      return row;
    });

    return { accessToken: this.token(user.id, user.email), user };
  }

  async login(dto: LoginDto) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, dto.email.toLowerCase()))
      .limit(1);
    if (!user || !verifyPassword(dto.password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return {
      accessToken: this.token(user.id, user.email),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        role: user.role,
      },
    };
  }

  /** Current user's profile (id, email, name, plan) — for `GET /auth/me`. */
  async me(userId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        plan: users.plan,
        planExpiresAt: users.planExpiresAt,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
