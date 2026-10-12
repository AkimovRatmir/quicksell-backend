/**
 * Bootstrap / manage admins from the command line.
 *
 * The FIRST admin must be created this way (an API that creates admins would
 * itself need admin auth — chicken-and-egg). After that, either re-run this for
 * each co-founder, or promote them from the admin panel.
 *
 *   bun run scripts/make-admin.ts <email> <password> [name]
 *
 * - If the email already exists  → promotes that user to admin.
 * - If it doesn't                → creates a new admin account.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { hashPassword } from '../src/crypto/crypto.util';

const [, , emailArg, password, name = 'Admin'] = process.argv;
if (!emailArg || (!password && true)) {
  console.error('Usage: bun run scripts/make-admin.ts <email> <password> [name]');
  process.exit(1);
}
const email = emailArg.toLowerCase();

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  const [existing] = await sql`SELECT id, role FROM users WHERE email = ${email}`;
  if (existing) {
    await sql`UPDATE users SET role = 'admin', updated_at = now() WHERE id = ${existing.id}`;
    console.log(`✓ Promoted existing user ${email} to admin (was role='${existing.role}').`);
  } else {
    if (!password) {
      console.error('New account needs a password: make-admin.ts <email> <password> [name]');
      process.exit(1);
    }
    const [u] = await sql`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (${email}, ${hashPassword(password)}, ${name}, 'admin')
      RETURNING id`;
    console.log(`✓ Created admin ${email} (id ${u.id}).`);
  }
} finally {
  await sql.end();
}
