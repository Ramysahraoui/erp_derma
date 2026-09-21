# ---------------------------------------------------------------------
# API metier ERP dermo-cosmetique
# ---------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Chromium est le moteur de rendu des documents PDF (bons de pesee, dossiers de
# lot, bons de livraison, factures, etiquettes).
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-dejavu tzdata curl \
 && addgroup -g 1001 erp && adduser -D -u 1001 -G erp erp
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Les migrations SQL sont lues a l'execution : elles accompagnent le binaire.
COPY src/db/migrations ./dist/db/migrations

RUN mkdir -p /app/uploads && chown -R erp:erp /app
USER erp
EXPOSE 3000
ENV UPLOAD_DIR=/app/uploads
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/sante || exit 1
CMD ["node", "dist/server.js"]
