#!/bin/bash
# Database Backup Script for Sniper Bot

set -e

# Create backups directory if it doesn't exist
mkdir -p backups

# Timestamp for backup files
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "🔄 Creating database backups..."

# PostgreSQL backup
echo "📦 Backing up PostgreSQL..."
docker compose exec -T postgres pg_dump -U postgres sniper_bot > "backups/postgres_backup_${TIMESTAMP}.sql"
PG_SIZE=$(du -h "backups/postgres_backup_${TIMESTAMP}.sql" | cut -f1)
echo "✅ PostgreSQL backup created: postgres_backup_${TIMESTAMP}.sql (${PG_SIZE})"

# Redis backup
echo "📦 Backing up Redis..."
docker compose exec -T redis redis-cli SAVE > /dev/null 2>&1
docker compose cp redis:/data/dump.rdb "backups/redis_backup_${TIMESTAMP}.rdb" 2>&1 | grep -v "the attribute"
REDIS_SIZE=$(du -h "backups/redis_backup_${TIMESTAMP}.rdb" | cut -f1)
echo "✅ Redis backup created: redis_backup_${TIMESTAMP}.rdb (${REDIS_SIZE})"

# Optional: Clean up old backups (keep only last 7 days)
echo "🧹 Cleaning up old backups (keeping last 7 days)..."
find backups/ -name "*.sql" -mtime +7 -delete
find backups/ -name "*.rdb" -mtime +7 -delete

echo ""
echo "✨ Backup completed successfully!"
echo "📂 Location: backups/"
ls -lh backups/ | tail -n 2
