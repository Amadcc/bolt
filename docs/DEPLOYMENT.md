# Production Deployment Guide

## Table of Contents

- [Infrastructure Requirements](#infrastructure-requirements)
- [Environment Variables](#environment-variables)
- [Deployment Methods](#deployment-methods)
  - [Docker Deployment](#docker-deployment)
  - [Kubernetes Deployment](#kubernetes-deployment)
  - [Bare Metal Deployment](#bare-metal-deployment)
- [Database Migration Process](#database-migration-process)
- [Security Hardening](#security-hardening)
- [Post-Deployment Validation](#post-deployment-validation)
- [Rollback Procedures](#rollback-procedures)

---

## Infrastructure Requirements

### Minimum Requirements (Development/Testing)

- **CPU:** 2 cores
- **RAM:** 4 GB
- **Storage:** 20 GB SSD
- **Network:** 10 Mbps
- **OS:** Ubuntu 22.04 LTS or macOS

### Recommended Requirements (Production)

- **CPU:** 4+ cores (8+ for high-frequency trading)
- **RAM:** 8 GB (16 GB for optimal performance)
- **Storage:** 50 GB SSD (NVMe preferred)
- **Network:** 100+ Mbps with low latency (&lt;50ms to RPC endpoints)
- **OS:** Ubuntu 22.04 LTS (kernel 5.15+)

### External Services Required

| Service | Purpose | Minimum Tier | Cost Estimate |
|---------|---------|--------------|---------------|
| **PostgreSQL 15+** | Primary database | 2 vCPU, 4GB RAM | $20-50/month |
| **Redis 7+** | Session cache, circuit breaker state | 1 vCPU, 2GB RAM | $10-30/month |
| **Solana RPC** | Blockchain access | Premium tier (Helius/QuickNode) | $0-99/month |
| **Telegram Bot API** | User interface | N/A | Free |
| **(Optional) Geyser gRPC** | Ultra-low latency pool detection | Chainstack | $49/month |

### Cloud Provider Recommendations

**AWS:**
- EC2: `c6i.xlarge` or `c6i.2xlarge` (compute-optimized)
- RDS: PostgreSQL 15, `db.t3.medium` or `db.r6g.large`
- ElastiCache: Redis 7, `cache.t3.medium`
- Region: `us-east-1` (closest to Solana validators)

**DigitalOcean:**
- Droplet: CPU-Optimized, 4 vCPU, 8GB RAM ($84/month)
- Managed Database: PostgreSQL 15, 2 vCPU, 4GB RAM ($60/month)
- Managed Redis: 1GB RAM ($15/month)
- Region: `nyc1` or `sfo3`

**Hetzner (Budget Option):**
- VPS: CPX31 (4 vCPU, 8GB RAM) (~€15/month)
- Self-hosted PostgreSQL + Redis
- Region: `nbg1` (Nuremberg) or `ash` (Ashburn)

---

## Environment Variables

### Required Variables

```bash
# Telegram Bot Configuration
BOT_TOKEN="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"

# Database Configuration (PostgreSQL)
DATABASE_URL="postgresql://postgres:STRONG_PASSWORD@postgres-host:5432/sniper_bot?schema=public"

# Redis Configuration
REDIS_URL="redis://redis-host:6379"

# Solana Network Configuration
SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
SOLANA_NETWORK="mainnet"  # mainnet | devnet | testnet

# Application Configuration
NODE_ENV="production"
PORT=3000

# Security Configuration
SESSION_MASTER_SECRET="BASE64_ENCODED_64_BYTE_SECRET"  # CRITICAL - Generate with: node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"

# Trading Configuration
PLATFORM_FEE_BPS=50  # 0.5% platform fee
PLATFORM_FEE_ACCOUNT="YOUR_SOLANA_WALLET_ADDRESS"

# CORS Configuration (Production domains only)
ALLOWED_ORIGINS="https://yourdomain.com,https://www.yourdomain.com"
```

### Optional Variables (Recommended for Production)

```bash
# Premium RPC Endpoints (Highly Recommended)
HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY"
QUICKNODE_RPC_URL="https://YOUR_ENDPOINT.solana-mainnet.quiknode.pro/YOUR_TOKEN/"

# Jupiter API Configuration
JUPITER_API_URL="https://lite-api.jup.ag"

# Geyser Plugin Configuration (Optional - Advanced Performance)
GEYSER_ENABLED=true
GEYSER_ENDPOINT="grpc.chainstack.com:443"
GEYSER_TOKEN="YOUR_GEYSER_TOKEN"
GEYSER_COMMITMENT="confirmed"
```

### Generating Secrets

**SESSION_MASTER_SECRET** (CRITICAL):
```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"

# OR using Bun
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64'))"

# OR using OpenSSL
openssl rand -base64 64 | tr -d '\n'
```

**POSTGRES_PASSWORD**:
```bash
openssl rand -base64 32 | tr -d '\n'
```

### Environment-Specific Configurations

**Development (.env.development)**:
```bash
NODE_ENV="development"
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/sniper_bot?schema=public"
REDIS_URL="redis://localhost:6380"
SOLANA_NETWORK="devnet"
SOLANA_RPC_URL="https://api.devnet.solana.com"
```

**Staging (.env.staging)**:
```bash
NODE_ENV="staging"
DATABASE_URL="postgresql://postgres:STRONG_PASSWORD@staging-db:5432/sniper_bot?schema=public"
REDIS_URL="redis://staging-redis:6379"
SOLANA_NETWORK="devnet"
SOLANA_RPC_URL="https://api.devnet.solana.com"
```

**Production (.env.production)**:
```bash
NODE_ENV="production"
DATABASE_URL="postgresql://postgres:STRONG_PASSWORD@prod-db:5432/sniper_bot?schema=public"
REDIS_URL="redis://prod-redis:6379"
SOLANA_NETWORK="mainnet"
HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY"
```

---

## Deployment Methods

### Docker Deployment

#### Step 1: Create Dockerfile

Create `Dockerfile` in project root:

```dockerfile
# Multi-stage build for optimal image size
FROM oven/bun:1.1-alpine AS builder

WORKDIR /app

# Copy dependency files
COPY package.json bun.lockb ./
COPY prisma ./prisma/

# Install dependencies
RUN bun install --frozen-lockfile --production=false

# Copy source code
COPY . .

# Generate Prisma Client
RUN bunx prisma generate

# Build application
RUN bun run build

# Production stage
FROM oven/bun:1.1-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json bun.lockb ./
COPY prisma ./prisma/
RUN bun install --frozen-lockfile --production && \
    bunx prisma generate

# Copy built application from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
```

#### Step 2: Create docker-compose.production.yml

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: sniper-bot
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env.production
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - sniper-net
    volumes:
      - app-logs:/app/logs
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '1'
          memory: 2G

  postgres:
    image: postgres:15-alpine
    container_name: sniper-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-sniper_bot}
      POSTGRES_INITDB_ARGS: "-E UTF8 --locale=en_US.UTF-8"
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - sniper-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres}"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 2G

  redis:
    image: redis:7-alpine
    container_name: sniper-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 1gb --maxmemory-policy allkeys-lru
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - sniper-net
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 1G

networks:
  sniper-net:
    driver: bridge

volumes:
  postgres-data:
    driver: local
  redis-data:
    driver: local
  app-logs:
    driver: local
```

#### Step 3: Deploy with Docker Compose

```bash
# 1. Clone repository
git clone https://github.com/your-org/bolt-sniper-bot.git
cd bolt-sniper-bot

# 2. Create production environment file
cp .env.example .env.production
nano .env.production  # Edit with production values

# 3. Build and start services
docker-compose -f docker-compose.production.yml up -d

# 4. Run database migrations
docker exec sniper-bot bunx prisma migrate deploy

# 5. Verify deployment
docker-compose -f docker-compose.production.yml ps
docker-compose -f docker-compose.production.yml logs -f app

# 6. Test bot
# Open Telegram and send /start to your bot
```

#### Step 4: Docker Management Commands

```bash
# View logs
docker-compose -f docker-compose.production.yml logs -f

# Restart application only
docker-compose -f docker-compose.production.yml restart app

# Stop all services
docker-compose -f docker-compose.production.yml down

# Stop and remove volumes (WARNING: Deletes all data)
docker-compose -f docker-compose.production.yml down -v

# Update to latest version
git pull
docker-compose -f docker-compose.production.yml build --no-cache
docker-compose -f docker-compose.production.yml up -d

# Database backup
docker exec sniper-postgres pg_dump -U postgres sniper_bot > backup_$(date +%Y%m%d_%H%M%S).sql

# Database restore
docker exec -i sniper-postgres psql -U postgres sniper_bot < backup_20250118_120000.sql
```

---

### Kubernetes Deployment

#### Prerequisites

- Kubernetes cluster (v1.27+)
- `kubectl` configured
- Helm 3+ (optional but recommended)

#### Step 1: Create Kubernetes Namespace

Create `k8s/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: sniper-bot
  labels:
    name: sniper-bot
    environment: production
```

Apply:
```bash
kubectl apply -f k8s/namespace.yaml
```

#### Step 2: Create Secrets

Create `k8s/secrets.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: sniper-bot-secrets
  namespace: sniper-bot
type: Opaque
stringData:
  BOT_TOKEN: "YOUR_TELEGRAM_BOT_TOKEN"
  DATABASE_URL: "postgresql://postgres:STRONG_PASSWORD@postgres-service:5432/sniper_bot?schema=public"
  REDIS_URL: "redis://redis-service:6379"
  SESSION_MASTER_SECRET: "YOUR_BASE64_ENCODED_64_BYTE_SECRET"
  PLATFORM_FEE_ACCOUNT: "YOUR_SOLANA_WALLET_ADDRESS"
  HELIUS_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY"
  QUICKNODE_RPC_URL: "https://YOUR_ENDPOINT.solana-mainnet.quiknode.pro/YOUR_TOKEN/"
```

Apply (WARNING: Sensitive data):
```bash
kubectl apply -f k8s/secrets.yaml
```

Better approach - Use sealed secrets or external secret manager:
```bash
# Using kubeseal (Sealed Secrets)
kubeseal --format=yaml < k8s/secrets.yaml > k8s/sealed-secrets.yaml
kubectl apply -f k8s/sealed-secrets.yaml

# OR using AWS Secrets Manager + External Secrets Operator
# See: https://external-secrets.io/
```

#### Step 3: Create ConfigMap

Create `k8s/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: sniper-bot-config
  namespace: sniper-bot
data:
  NODE_ENV: "production"
  PORT: "3000"
  SOLANA_NETWORK: "mainnet"
  SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com"
  JUPITER_API_URL: "https://lite-api.jup.ag"
  PLATFORM_FEE_BPS: "50"
  ALLOWED_ORIGINS: "https://yourdomain.com"
  GEYSER_ENABLED: "false"
  GEYSER_COMMITMENT: "confirmed"
```

Apply:
```bash
kubectl apply -f k8s/configmap.yaml
```

#### Step 4: Deploy PostgreSQL

Create `k8s/postgres-deployment.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-pvc
  namespace: sniper-bot
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
  storageClassName: fast-ssd  # Use your cluster's SSD storage class
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: sniper-bot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:15-alpine
        ports:
        - containerPort: 5432
        env:
        - name: POSTGRES_USER
          value: "postgres"
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: sniper-bot-secrets
              key: POSTGRES_PASSWORD
        - name: POSTGRES_DB
          value: "sniper_bot"
        - name: POSTGRES_INITDB_ARGS
          value: "-E UTF8 --locale=en_US.UTF-8"
        volumeMounts:
        - name: postgres-storage
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        livenessProbe:
          exec:
            command:
            - pg_isready
            - -U
            - postgres
          initialDelaySeconds: 30
          periodSeconds: 10
      volumes:
      - name: postgres-storage
        persistentVolumeClaim:
          claimName: postgres-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: postgres-service
  namespace: sniper-bot
spec:
  selector:
    app: postgres
  ports:
  - port: 5432
    targetPort: 5432
  type: ClusterIP
```

Apply:
```bash
kubectl apply -f k8s/postgres-deployment.yaml
```

#### Step 5: Deploy Redis

Create `k8s/redis-deployment.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis-pvc
  namespace: sniper-bot
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: fast-ssd
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: sniper-bot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        command:
        - redis-server
        - --appendonly
        - "yes"
        - --maxmemory
        - "1gb"
        - --maxmemory-policy
        - allkeys-lru
        ports:
        - containerPort: 6379
        volumeMounts:
        - name: redis-storage
          mountPath: /data
        resources:
          requests:
            cpu: 250m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 2Gi
        livenessProbe:
          exec:
            command:
            - redis-cli
            - ping
          initialDelaySeconds: 10
          periodSeconds: 10
      volumes:
      - name: redis-storage
        persistentVolumeClaim:
          claimName: redis-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: redis-service
  namespace: sniper-bot
spec:
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379
  type: ClusterIP
```

Apply:
```bash
kubectl apply -f k8s/redis-deployment.yaml
```

#### Step 6: Deploy Application

Create `k8s/app-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sniper-bot
  namespace: sniper-bot
spec:
  replicas: 2  # Horizontal scaling
  selector:
    matchLabels:
      app: sniper-bot
  template:
    metadata:
      labels:
        app: sniper-bot
    spec:
      containers:
      - name: sniper-bot
        image: your-registry/sniper-bot:latest
        imagePullPolicy: Always
        ports:
        - containerPort: 3000
        envFrom:
        - configMapRef:
            name: sniper-bot-config
        - secretRef:
            name: sniper-bot-secrets
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 60
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: sniper-bot-service
  namespace: sniper-bot
spec:
  selector:
    app: sniper-bot
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer  # Or ClusterIP if using Ingress
```

Apply:
```bash
kubectl apply -f k8s/app-deployment.yaml
```

#### Step 7: Run Database Migrations

Create `k8s/migration-job.yaml`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: prisma-migrate
  namespace: sniper-bot
spec:
  template:
    spec:
      containers:
      - name: prisma-migrate
        image: your-registry/sniper-bot:latest
        command: ["bunx", "prisma", "migrate", "deploy"]
        envFrom:
        - configMapRef:
            name: sniper-bot-config
        - secretRef:
            name: sniper-bot-secrets
      restartPolicy: OnFailure
  backoffLimit: 3
```

Apply:
```bash
kubectl apply -f k8s/migration-job.yaml
kubectl logs -n sniper-bot job/prisma-migrate -f
```

#### Step 8: Kubernetes Management Commands

```bash
# Check deployment status
kubectl get all -n sniper-bot

# View application logs
kubectl logs -n sniper-bot -l app=sniper-bot -f

# Scale application
kubectl scale deployment sniper-bot -n sniper-bot --replicas=3

# Update application
docker build -t your-registry/sniper-bot:v1.1.0 .
docker push your-registry/sniper-bot:v1.1.0
kubectl set image deployment/sniper-bot -n sniper-bot sniper-bot=your-registry/sniper-bot:v1.1.0

# Rollback deployment
kubectl rollout undo deployment/sniper-bot -n sniper-bot

# Database backup
kubectl exec -n sniper-bot -it $(kubectl get pod -n sniper-bot -l app=postgres -o jsonpath='{.items[0].metadata.name}') -- pg_dump -U postgres sniper_bot > backup.sql
```

---

### Bare Metal Deployment

#### Prerequisites

- Ubuntu 22.04 LTS
- Root or sudo access
- Public IP address (for Telegram webhook)

#### Step 1: System Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install dependencies
sudo apt install -y curl wget git build-essential postgresql-15 redis-server nginx certbot python3-certbot-nginx

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Verify installation
bun --version
```

#### Step 2: Database Setup

```bash
# Configure PostgreSQL
sudo -u postgres psql

# Inside psql:
CREATE DATABASE sniper_bot;
CREATE USER sniper_bot_user WITH ENCRYPTED PASSWORD 'STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE sniper_bot TO sniper_bot_user;
\q

# Configure Redis (edit /etc/redis/redis.conf)
sudo nano /etc/redis/redis.conf

# Add these lines:
# maxmemory 1gb
# maxmemory-policy allkeys-lru
# appendonly yes

# Restart Redis
sudo systemctl restart redis-server
```

#### Step 3: Application Setup

```bash
# Create application user
sudo useradd -m -s /bin/bash sniper-bot
sudo su - sniper-bot

# Clone repository
git clone https://github.com/your-org/bolt-sniper-bot.git
cd bolt-sniper-bot

# Install dependencies
bun install

# Setup environment
cp .env.example .env
nano .env  # Edit with production values

# Generate Prisma Client
bunx prisma generate

# Run migrations
bunx prisma migrate deploy

# Build application
bun run build

# Exit sniper-bot user
exit
```

#### Step 4: Create Systemd Service

Create `/etc/systemd/system/sniper-bot.service`:

```ini
[Unit]
Description=Solana Token Sniper Bot
After=network.target postgresql.service redis.service
Wants=postgresql.service redis.service

[Service]
Type=simple
User=sniper-bot
Group=sniper-bot
WorkingDirectory=/home/sniper-bot/bolt-sniper-bot
ExecStart=/home/sniper-bot/.bun/bin/bun run dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sniper-bot

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/home/sniper-bot/bolt-sniper-bot/logs

# Resource limits
LimitNOFILE=65536
MemoryMax=8G
CPUQuota=400%

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable sniper-bot
sudo systemctl start sniper-bot
sudo systemctl status sniper-bot
```

#### Step 5: Configure Nginx (Optional - For Metrics/Health Endpoint)

Create `/etc/nginx/sites-available/sniper-bot`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }

    location /metrics {
        proxy_pass http://localhost:3000/metrics;
        allow 10.0.0.0/8;  # Internal network only
        deny all;
    }
}
```

Enable site and SSL:
```bash
sudo ln -s /etc/nginx/sites-available/sniper-bot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com
```

---

## Database Migration Process

### Production Migration Strategy

#### Pre-Migration Checklist

- [ ] Backup database (see backup commands below)
- [ ] Test migrations in staging environment
- [ ] Review migration SQL for breaking changes
- [ ] Schedule maintenance window (if downtime required)
- [ ] Notify users of upcoming maintenance
- [ ] Prepare rollback plan

#### Migration Commands

```bash
# 1. Backup production database
pg_dump -U postgres -h prod-db-host -d sniper_bot -F c -b -v -f backup_pre_migration_$(date +%Y%m%d_%H%M%S).backup

# 2. Test migration in staging (DRY RUN)
DATABASE_URL="postgresql://postgres:password@staging-db:5432/sniper_bot" \
  bunx prisma migrate deploy --preview-feature

# 3. Apply production migration
DATABASE_URL="postgresql://prod-connection-string" \
  bunx prisma migrate deploy

# 4. Verify migration
DATABASE_URL="postgresql://prod-connection-string" \
  bunx prisma migrate status

# 5. Generate Prisma Client (if schema changed)
bunx prisma generate
```

#### Zero-Downtime Migration Pattern

For breaking schema changes:

```bash
# Step 1: Add new column (non-breaking)
bunx prisma migrate deploy

# Step 2: Deploy new application version (reads from both old and new columns)
kubectl set image deployment/sniper-bot sniper-bot=your-registry/sniper-bot:v1.1.0

# Step 3: Backfill data (if needed)
bunx prisma db execute --file migrations/backfill.sql

# Step 4: Deploy final version (reads only from new column)
kubectl set image deployment/sniper-bot sniper-bot=your-registry/sniper-bot:v1.2.0

# Step 5: Remove old column (after verification)
bunx prisma migrate deploy
```

#### Rollback Migration

```bash
# Restore from backup
pg_restore -U postgres -h prod-db-host -d sniper_bot -c backup_pre_migration_20250118_120000.backup

# OR manually rollback specific migration
DATABASE_URL="postgresql://prod-connection-string" \
  bunx prisma migrate resolve --rolled-back 20250118120000_migration_name

# Redeploy previous application version
kubectl rollout undo deployment/sniper-bot -n sniper-bot
```

---

## Security Hardening

### Application Security

1. **Environment Variables:**
   - Never commit `.env` files
   - Use secret managers (AWS Secrets Manager, HashiCorp Vault)
   - Rotate `SESSION_MASTER_SECRET` quarterly
   - Use different secrets per environment

2. **Database Security:**
   - Use strong passwords (32+ characters)
   - Enable SSL/TLS for database connections
   - Restrict database access by IP
   - Regular backups (hourly incremental, daily full)
   - Enable audit logging

3. **Redis Security:**
   - Disable anonymous access
   - Use ACLs (Redis 6+)
   - Enable TLS for Redis connections
   - Configure `maxmemory-policy` to prevent DoS

4. **Network Security:**
   - Use firewall (ufw, iptables, security groups)
   - Close unnecessary ports
   - Use VPN for administrative access
   - Enable DDoS protection (Cloudflare, AWS Shield)

### Firewall Configuration (ufw)

```bash
# Allow SSH (change port if using non-standard)
sudo ufw allow 22/tcp

# Allow HTTP/HTTPS (if using Nginx)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow PostgreSQL (only from application server IP)
sudo ufw allow from 10.0.1.100 to any port 5432

# Allow Redis (only from application server IP)
sudo ufw allow from 10.0.1.100 to any port 6379

# Deny all other traffic
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Enable firewall
sudo ufw enable
```

### Security Best Practices

- [ ] Enable HTTPS only (no HTTP)
- [ ] Implement rate limiting on Telegram bot commands
- [ ] Use non-root user for application
- [ ] Regular security updates (`apt upgrade`)
- [ ] Monitor failed authentication attempts
- [ ] Implement intrusion detection (fail2ban)
- [ ] Regular security audits (`npm audit`)
- [ ] Use Content Security Policy headers
- [ ] Enable CORS only for trusted origins

---

## Post-Deployment Validation

### Health Checks

```bash
# 1. Application health endpoint
curl -f http://localhost:3000/health || echo "Health check failed"

# 2. Database connectivity
bunx prisma db execute --stdin <<< "SELECT 1;"

# 3. Redis connectivity
redis-cli ping

# 4. Telegram bot connectivity
curl -X POST https://api.telegram.org/bot${BOT_TOKEN}/getMe
```

### Functional Tests

```bash
# Test bot commands via Telegram:
# 1. Send /start - Should receive welcome message
# 2. Send /help - Should receive command list
# 3. Send /createwallet - Should create wallet
# 4. Send /balance - Should show wallet balance

# Check logs for errors
journalctl -u sniper-bot -n 100 --no-pager

# Docker logs
docker logs sniper-bot --tail 100

# Kubernetes logs
kubectl logs -n sniper-bot -l app=sniper-bot --tail=100
```

### Performance Validation

```bash
# Check CPU/Memory usage
top
htop
docker stats
kubectl top pods -n sniper-bot

# Check RPC latency
bunx ts-node scripts/test-rpc-latency.ts

# Check database query performance
psql -U postgres -d sniper_bot -c "SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
```

---

## Rollback Procedures

### Application Rollback

**Docker:**
```bash
# Rollback to previous image
docker-compose -f docker-compose.production.yml pull app:v1.0.0
docker-compose -f docker-compose.production.yml up -d app
```

**Kubernetes:**
```bash
# View rollout history
kubectl rollout history deployment/sniper-bot -n sniper-bot

# Rollback to previous revision
kubectl rollout undo deployment/sniper-bot -n sniper-bot

# Rollback to specific revision
kubectl rollout undo deployment/sniper-bot -n sniper-bot --to-revision=2
```

**Bare Metal:**
```bash
# Switch to previous version
cd /home/sniper-bot/bolt-sniper-bot
git checkout v1.0.0
bun install
bunx prisma generate
bun run build
sudo systemctl restart sniper-bot
```

### Database Rollback

```bash
# Restore from backup (PostgreSQL)
pg_restore -U postgres -h db-host -d sniper_bot -c backup_20250118_120000.backup

# Restore from SQL dump
psql -U postgres -h db-host -d sniper_bot < backup_20250118_120000.sql
```

### Complete System Rollback

```bash
# 1. Restore database
pg_restore -U postgres -d sniper_bot -c backup_pre_deployment.backup

# 2. Rollback application
kubectl rollout undo deployment/sniper-bot -n sniper-bot

# 3. Verify functionality
kubectl logs -n sniper-bot -l app=sniper-bot -f
# Test bot commands

# 4. Monitor for issues
kubectl get pods -n sniper-bot -w
```

---

## Monitoring & Observability

### Metrics Endpoint

Application exposes Prometheus metrics at `/metrics`:

```bash
# View metrics
curl http://localhost:3000/metrics

# Key metrics to monitor:
# - circuit_breaker_state{name="rpc_pool"}
# - rpc_request_duration_seconds
# - swap_execution_duration_seconds
# - honeypot_check_duration_seconds
# - telegram_command_total
```

### Log Aggregation

**Using journald (Bare Metal):**
```bash
journalctl -u sniper-bot -f
```

**Using Docker:**
```bash
docker logs sniper-bot -f --tail 100
```

**Using Kubernetes:**
```bash
kubectl logs -n sniper-bot -l app=sniper-bot -f
```

### Alerting

Set up alerts for:
- Circuit breaker state = OPEN (RPC failure)
- High error rate (&gt;5% of requests)
- Database connection failures
- Redis connection failures
- High memory usage (&gt;80%)
- High CPU usage (&gt;80%)
- Disk space low (&lt;20% free)

---

## Performance Monitoring & Benchmarking

### Performance Targets

The sniper bot has specific performance targets that should be monitored:

| Component | Target | Critical Threshold |
|-----------|--------|-------------------|
| **Pool Detection** | <500ms (p95) | >1000ms |
| **Honeypot Check** | <2s (p95) | >3s |
| **Trade Execution** | <1.5s (p95) | >2.5s |
| **Full Sniper Flow** | <4s (p95) | >6s |
| **Position Monitor** | <500ms (p95) | >1s |
| **Rug Detection** | <500ms (p95) | >1s |
| **Memory Usage** | <500MB peak | >1GB |
| **CPU Usage** | <80% average | >90% |

### Running Performance Benchmarks

**Comprehensive Benchmarks (all components):**
```bash
# Run all performance benchmarks
bun test tests/performance/comprehensive.test.ts

# Expected output:
# ✓ Detection latency <500ms
# ✓ Honeypot check <2s
# ✓ Execution time <1.5s
# ✓ Full flow <4s
# ✓ All 13 components within targets
```

**Load Testing (concurrent capacity):**
```bash
# Test with 100 concurrent snipes (target capacity)
bun test tests/load/concurrent-snipes.test.ts

# Scenarios tested:
# - BASELINE: 10 concurrent (30s)
# - MODERATE: 50 concurrent (60s)
# - HEAVY: 100 concurrent (90s) ← Target capacity
# - STRESS: 200 concurrent (60s)
# - SPIKE: 0→100 rapid spike
```

### Grafana Performance Dashboard

Import the performance dashboard located at `grafana/dashboards/performance.json`:

```bash
# Using Grafana API
curl -X POST \
  -H "Content-Type: application/json" \
  -d @grafana/dashboards/performance.json \
  http://admin:admin@localhost:3000/api/dashboards/db

# Or manually import via Grafana UI:
# 1. Login to Grafana (http://localhost:3000)
# 2. Go to Dashboards → Import
# 3. Upload grafana/dashboards/performance.json
```

**Dashboard Features:**
- Real-time latency tracking (p50, p75, p95, p99)
- Success rate monitoring
- Memory and CPU usage
- Throughput metrics (ops/second)
- Load test concurrency visualization
- Performance target compliance table

### Key Metrics to Monitor

**Prometheus Metrics (available at /metrics):**

1. **Latency Metrics:**
   ```promql
   # p95 latency by component
   histogram_quantile(0.95, sum(rate(benchmark_duration_ms_bucket[5m])) by (component, le))

   # Full sniper flow latency
   histogram_quantile(0.95, sum(rate(benchmark_duration_ms_bucket{component="FULL_FLOW"}[5m])) by (le))
   ```

2. **Success Rate:**
   ```promql
   # Success rate by component
   benchmark_success_rate{component="EXECUTION"}

   # Overall success rate
   avg(benchmark_success_rate)
   ```

3. **Throughput:**
   ```promql
   # Operations per second
   benchmark_throughput_ops{component="EXECUTION"}
   ```

4. **Resource Usage:**
   ```promql
   # Peak memory usage
   benchmark_memory_mb

   # CPU utilization
   benchmark_cpu_percent
   ```

5. **Load Test Metrics:**
   ```promql
   # Concurrent request count
   load_test_concurrency{scenario="HEAVY"}

   # Request rate by status
   sum(rate(load_test_requests_total[5m])) by (scenario, status)
   ```

### Alerting Rules

**Prometheus Alert Rules (create alerts.yml):**

```yaml
groups:
  - name: performance
    interval: 30s
    rules:
      # Detection latency alert
      - alert: HighDetectionLatency
        expr: histogram_quantile(0.95, sum(rate(benchmark_duration_ms_bucket{component="DETECTION"}[5m])) by (le)) > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Pool detection latency above target"
          description: "p95 latency is {{ $value }}ms (target: <500ms)"

      # Honeypot check latency alert
      - alert: HighHoneypotCheckLatency
        expr: histogram_quantile(0.95, sum(rate(benchmark_duration_ms_bucket{component="HONEYPOT"}[5m])) by (le)) > 3000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Honeypot check latency above target"
          description: "p95 latency is {{ $value }}ms (target: <2000ms)"

      # Execution latency alert
      - alert: HighExecutionLatency
        expr: histogram_quantile(0.95, sum(rate(benchmark_duration_ms_bucket{component="EXECUTION"}[5m])) by (le)) > 2500
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Trade execution latency critical"
          description: "p95 latency is {{ $value }}ms (target: <1500ms)"

      # Full flow latency alert
      - alert: HighFullFlowLatency
        expr: histogram_quantile(0.95, sum(rate(benchmark_duration_ms_bucket{component="FULL_FLOW"}[5m])) by (le)) > 6000
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "End-to-end sniper flow too slow"
          description: "p95 latency is {{ $value }}ms (target: <4000ms)"

      # Success rate alert
      - alert: LowSuccessRate
        expr: benchmark_success_rate < 70
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.component }} success rate below 70%"
          description: "Success rate is {{ $value }}%"

      # Memory usage alert
      - alert: HighMemoryUsage
        expr: benchmark_memory_mb > 800
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Memory usage approaching limit"
          description: "Peak memory is {{ $value }}MB (limit: 500MB)"

      # CPU usage alert
      - alert: HighCPUUsage
        expr: benchmark_cpu_percent > 90
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "CPU usage critical"
          description: "CPU usage is {{ $value }}%"
```

### Performance Optimization Checklist

Before production deployment, verify:

- [ ] All performance benchmarks passing
- [ ] Load tests complete successfully at 100+ concurrent
- [ ] p95 latency within targets for all components
- [ ] Success rate >90% for critical components
- [ ] Memory usage <500MB peak under load
- [ ] CPU usage <80% average under load
- [ ] Grafana dashboard configured
- [ ] Prometheus alerts set up
- [ ] Performance baselines documented

### Continuous Performance Monitoring

**Daily Performance Reports:**
```bash
# Run benchmarks daily and save results
bun test tests/performance/comprehensive.test.ts > performance_$(date +%Y%m%d).log

# Compare against baseline
diff performance_baseline.log performance_$(date +%Y%m%d).log
```

**Weekly Load Testing:**
```bash
# Run load tests weekly to verify capacity
bun test tests/load/concurrent-snipes.test.ts

# Monitor for performance degradation over time
```

### Troubleshooting Performance Issues

**If latency is high:**
1. Check RPC endpoint latency: `bunx ts-node scripts/test-rpc-latency.ts`
2. Verify Redis cache hit rate in logs
3. Check database query performance: `psql -c "SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"`
4. Review circuit breaker states: `curl http://localhost:3000/metrics | grep circuit_breaker_state`

**If success rate is low:**
1. Check honeypot API availability
2. Review filter configurations (may be too strict)
3. Verify Jito bundle success rate
4. Check for RPC rate limiting

**If memory usage is high:**
1. Review Redis cache size
2. Check for memory leaks: `bunx --inspect dist/index.js`
3. Verify proper cleanup in WebSocket connections
4. Monitor heap usage over time

---

## Backup Strategy

### Database Backups

**Automated Daily Backups (cron):**

Create `/etc/cron.daily/backup-sniper-bot`:

```bash
#!/bin/bash
BACKUP_DIR=/backups/sniper-bot
DATE=$(date +%Y%m%d_%H%M%S)

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup PostgreSQL
pg_dump -U postgres -h localhost -d sniper_bot -F c -b -v -f $BACKUP_DIR/postgres_$DATE.backup

# Backup Redis
redis-cli --rdb $BACKUP_DIR/redis_$DATE.rdb

# Compress backups
gzip $BACKUP_DIR/postgres_$DATE.backup

# Delete backups older than 30 days
find $BACKUP_DIR -name "*.backup.gz" -mtime +30 -delete
find $BACKUP_DIR -name "*.rdb" -mtime +30 -delete

echo "Backup completed: $DATE"
```

Make executable:
```bash
sudo chmod +x /etc/cron.daily/backup-sniper-bot
```

---

## Troubleshooting

### Common Issues

**1. Bot not responding:**
```bash
# Check bot token
curl https://api.telegram.org/bot${BOT_TOKEN}/getMe

# Check application logs
journalctl -u sniper-bot -n 50

# Restart application
sudo systemctl restart sniper-bot
```

**2. Database connection errors:**
```bash
# Test database connectivity
psql -U postgres -h db-host -d sniper_bot -c "SELECT 1;"

# Check PostgreSQL status
sudo systemctl status postgresql

# Restart PostgreSQL
sudo systemctl restart postgresql
```

**3. Out of memory:**
```bash
# Check memory usage
free -h
docker stats

# Increase memory limit (Docker)
# Edit docker-compose.yml: memory: 8G

# Restart application
docker-compose restart app
```

---

**For operational procedures and troubleshooting, see [RUNBOOK.md](./RUNBOOK.md)**
