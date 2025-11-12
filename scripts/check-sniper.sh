#!/bin/bash

# 🎯 Quick Sniper Health Check Script
# Usage: ./scripts/check-sniper.sh

set -e

echo "🔍 Checking Sniper Status..."
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if server is running
if ! curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "${RED}❌ Server not running${NC}"
    echo "Run: bun dev"
    exit 1
fi

echo -e "${GREEN}✅ Server running${NC}"
echo ""

# Check discovery sources
echo "📡 Discovery Sources:"
if curl -s http://localhost:3000/metrics | grep -q 'snipe_orchestrator_started'; then
    echo -e "${GREEN}  ✅ Orchestrator active${NC}"
else
    echo -e "${RED}  ❌ Orchestrator not started${NC}"
fi

# Check Pump.fun connection
echo ""
echo "🔌 WebSocket Connections:"
if ps aux | grep -v grep | grep -q 'pumpportal'; then
    echo -e "${GREEN}  ✅ Pump.fun connected${NC}"
else
    echo -e "${YELLOW}  ⚠️  Pump.fun status unknown${NC}"
fi

# Check metrics
echo ""
echo "📊 Metrics:"
METRICS=$(curl -s http://localhost:3000/metrics | grep '^snipe_')

if [ -z "$METRICS" ]; then
    echo -e "${YELLOW}  ⚠️  No snipe metrics found${NC}"
else
    echo -e "${GREEN}  ✅ Metrics available${NC}"

    # Parse opportunities
    ACCEPTED=$(echo "$METRICS" | grep 'snipe_opportunities_total{status="accepted"}' | awk '{print $2}')
    REJECTED=$(echo "$METRICS" | grep 'snipe_opportunities_total{status="rejected"}' | awk '{print $2}')

    if [ ! -z "$ACCEPTED" ]; then
        echo "     Accepted: $ACCEPTED"
    fi
    if [ ! -z "$REJECTED" ]; then
        echo "     Rejected: $REJECTED"
    fi

    # Parse executions
    SUCCESS=$(echo "$METRICS" | grep 'snipe_execution_outcome_total{status="success"}' | awk '{print $2}')
    FAILED=$(echo "$METRICS" | grep 'snipe_execution_outcome_total{status="failed"}' | awk '{print $2}')

    if [ ! -z "$SUCCESS" ]; then
        echo -e "${GREEN}     ✅ Success: $SUCCESS${NC}"
    fi
    if [ ! -z "$FAILED" ]; then
        echo -e "${RED}     ❌ Failed: $FAILED${NC}"
    fi

    # Discovery events
    EMITTED=$(echo "$METRICS" | grep 'snipe_discovery_events_total' | grep 'status="emitted"' | awk '{print $2}' | paste -sd+ | bc 2>/dev/null || echo "0")
    if [ "$EMITTED" != "0" ]; then
        echo -e "${GREEN}     🔍 Tokens discovered: $EMITTED${NC}"
    else
        echo -e "${YELLOW}     ⏳ No tokens discovered yet${NC}"
    fi
fi

# Check Redis automation leases
echo ""
echo "🔐 Automation Leases:"
if command -v redis-cli > /dev/null 2>&1; then
    LEASE_COUNT=$(redis-cli -p 6380 KEYS "snipe:lease:*" 2>/dev/null | wc -l)
    if [ "$LEASE_COUNT" -gt 0 ]; then
        echo -e "${GREEN}  ✅ Active leases: $LEASE_COUNT${NC}"
    else
        echo -e "${YELLOW}  ⚠️  No active leases${NC}"
        echo "     Users need to grant automation access"
    fi
else
    echo -e "${YELLOW}  ⚠️  redis-cli not available${NC}"
fi

# Check database executions
echo ""
echo "💾 Recent Executions (last 5 min):"
if command -v psql > /dev/null 2>&1; then
    RECENT=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM \"SnipeExecution\" WHERE \"createdAt\" > NOW() - INTERVAL '5 minutes'" 2>/dev/null || echo "0")
    if [ "$RECENT" -gt 0 ]; then
        echo -e "${GREEN}  ✅ Recent executions: $RECENT${NC}"
    else
        echo -e "${YELLOW}  ⏳ No recent executions${NC}"
    fi
else
    echo -e "${YELLOW}  ⚠️  psql not available${NC}"
fi

# Final verdict
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if curl -s http://localhost:3000/metrics | grep -q 'snipe_orchestrator'; then
    echo -e "${GREEN}✅ SNIPER IS ACTIVE${NC}"
    echo ""
    echo "📖 View full guide: cat SNIPER_TESTING.md"
    echo "📊 Watch metrics: watch -n 1 'curl -s http://localhost:3000/metrics | grep snipe'"
    echo "📝 Watch logs: bun dev 2>&1 | grep -i snipe"
else
    echo -e "${RED}❌ SNIPER NOT FULLY ACTIVE${NC}"
    echo ""
    echo "🔧 Troubleshooting:"
    echo "  1. Check logs: bun dev"
    echo "  2. Verify .env file has all required vars"
    echo "  3. Check Redis is running: redis-cli -p 6380 ping"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
