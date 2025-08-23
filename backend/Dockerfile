# Multi-stage build for NestJS backend

FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies (including dev for build)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . ./
RUN npm run build


FROM node:20-alpine AS runner
WORKDIR /app

# Install production-only deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Optionally, copy static assets if any (none by default)

# Env & runtime
ENV NODE_ENV=production
ENV PORT=3000

# Expose HTTP port
EXPOSE 3000

# Note: mount Google credentials file at runtime; see docker-compose.yml

CMD ["node", "dist/main.js"]
