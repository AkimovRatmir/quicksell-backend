import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit loads this file independently of Nest's ConfigModule,
// so it must self-load .env via dotenv above.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
