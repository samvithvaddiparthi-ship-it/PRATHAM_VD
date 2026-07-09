# =============================================================
# OPD Pre-Consultation POC — Single-container deployment
# Runs: nginx + node-backend + python-backend + next.js frontend
# Targets: Railway, Render, any Docker-capable PaaS
# Build: v2 — includes protocols, prescriptions, scribe, analytics
# =============================================================

# ---- Stage 1: Build frontend ----
FROM node:20-alpine AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
# Single-container: nginx on localhost handles routing for all services
ENV NEXT_PUBLIC_API_BASE=""
ENV API_INTERNAL_URL="http://127.0.0.1:8080"
RUN npm run build

# ---- Stage 2: Install node backend deps ----
FROM node:20-alpine AS node-builder
WORKDIR /build/node-backend
COPY services/node-backend/package.json ./
RUN npm install --production

# ---- Stage 3: Final runtime ----
FROM python:3.12-slim

# Install system deps: node, nginx, tesseract, supervisord
RUN apt-get update && apt-get install -y \
    curl wget gnupg nginx supervisor \
    tesseract-ocr tesseract-ocr-hin tesseract-ocr-tel \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---- Python backend ----
WORKDIR /app/python-backend
COPY services/python-backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/python-backend/src/ ./src/

# ---- Node backend ----
WORKDIR /app/node-backend
COPY --from=node-builder /build/node-backend/node_modules ./node_modules
COPY services/node-backend/package.json ./
COPY services/node-backend/src/ ./src/

# ---- Frontend (standalone build) ----
WORKDIR /app/frontend
COPY --from=frontend-builder /build/frontend/.next/standalone ./
COPY --from=frontend-builder /build/frontend/.next/static ./.next/static
# `output: standalone` does NOT bundle public/ — copy it or the PWA icons 404.
COPY --from=frontend-builder /build/frontend/public ./public

# ---- DB migrations ----
COPY db/ /app/db/

# ---- Railway configs ----
COPY deploy/ /app/deploy/
RUN chmod +x /app/deploy/start.sh

WORKDIR /app
EXPOSE 8080

CMD ["/app/deploy/start.sh"]
