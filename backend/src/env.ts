/** Configuration applicative, chargee depuis l'environnement. */
const num = (v: string | undefined, def: number) => (v === undefined ? def : Number(v));

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@127.0.0.1:5432/erp_derma',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-a-remplacer-en-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  uploadDir: process.env.UPLOAD_DIR ?? new URL('../uploads/', import.meta.url).pathname,
  chromiumPath: process.env.CHROMIUM_PATH ?? '',
  devise: process.env.DEVISE ?? 'DZD',
};

export const isProd = env.nodeEnv === 'production';
