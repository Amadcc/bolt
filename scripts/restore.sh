#!/bin/bash
# Database Restore Script for Sniper Bot

set -e

# Check if backup file is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <backup_timestamp>"
    echo ""
    echo "Available backups:"
    ls -1 backups/*.sql 2>/dev/null | sed 's/backups\/postgres_backup_/  - /' | sed 's/\.sql$//' || echo "  No backups found"
    exit 1
fi

TIMESTAMP=$1
PG_BACKUP="backups/postgres_backup_${TIMESTAMP}.sql"
REDIS_BACKUP="backups/redis_backup_${TIMESTAMP}.rdb"

# Check if PostgreSQL backup exists
if [ ! -f "$PG_BACKUP" ]; then
    echo "❌ PostgreSQL backup not found: $PG_BACKUP"
    exit 1
fi

echo "⚠️  WARNING: This will replace the current database with the backup!"
read -p "Are you sure you want to continue? (yes/no): " -r
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Restore cancelled."
    exit 0
fi

echo ""
echo "🔄 Restoring databases from backup ${TIMESTAMP}..."

# Stop the bot if running
echo "⏸️  Stopping bot (if running)..."
# pkill -f "bun dev" || true

# PostgreSQL restore
echo "📦 Restoring PostgreSQL..."
docker compose exec -T postgres psql -U postgres -c "DROP DATABASE IF EXISTS sniper_bot;"
docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE sniper_bot;"
docker compose exec -T postgres psql -U postgres sniper_bot < "$PG_BACKUP"
echo "✅ PostgreSQL restored successfully"

# Redis restore (if backup exists)
if [ -f "$REDIS_BACKUP" ]; then
    echo "📦 Restoring Redis..."
    docker compose stop redis
    docker compose cp "$REDIS_BACKUP" redis:/data/dump.rdb
    docker compose start redis
    sleep 2
    echo "✅ Redis restored successfully"
else
    echo "⚠️  Redis backup not found, skipping..."
fi

echo ""
echo "✨ Restore completed successfully!"
echo "💡 You can now restart the bot with: bun dev"
