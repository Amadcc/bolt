# Monitoring Setup Guide

**Version:** 1.0.0
**Last Updated:** 2025-01-18
**Stack:** Prometheus + Grafana + Alertmanager
**Cost:** Free (self-hosted) or $50-100/month (cloud)

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Prometheus Setup](#prometheus-setup)
5. [Grafana Setup](#grafana-setup)
6. [Alertmanager Setup](#alertmanager-setup)
7. [Dashboard Configuration](#dashboard-configuration)
8. [Alert Rules](#alert-rules)
9. [Testing & Validation](#testing--validation)
10. [Production Best Practices](#production-best-practices)
11. [Troubleshooting](#troubleshooting)

---

## Overview

This guide sets up comprehensive monitoring for the Solana Token Sniper Bot using:

- **Prometheus** - Metrics collection and storage
- **Grafana** - Visualization and dashboards
- **Alertmanager** - Alert routing and notifications

**What You'll Monitor:**
- Application performance (latency, throughput, success rates)
- System resources (CPU, memory, disk)
- Circuit breaker states
- RPC endpoint health
- Geyser connection status
- Trading activity (orders, positions, P&L)

**Time to Complete:** 60-90 minutes

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Monitoring Architecture                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────┐         ┌─────────────────────────────────────┐
│  Sniper Bot App │────────▶│  Prometheus                         │
│  :3000/metrics  │         │  - Scrapes metrics every 15s        │
└─────────────────┘         │  - Stores 15 days of data           │
                            │  - Evaluates alert rules             │
                            └─────────────────────────────────────┘
                                          │
                       ┌──────────────────┴──────────────────┐
                       │                                     │
                       ▼                                     ▼
            ┌──────────────────┐              ┌──────────────────────┐
            │  Grafana         │              │  Alertmanager        │
            │  - Dashboards    │              │  - Alert routing     │
            │  - Visualization │              │  - Deduplication     │
            │  - User UI       │              │  - Notifications     │
            └──────────────────┘              └──────────────────────┘
                                                         │
                              ┌──────────────────────────┴─────────┐
                              │                                    │
                              ▼                                    ▼
                    ┌──────────────────┐            ┌──────────────────┐
                    │  Slack           │            │  PagerDuty       │
                    │  (Team alerts)   │            │  (On-call)       │
                    └──────────────────┘            └──────────────────┘
```

---

## Prerequisites

### Required

- [ ] Sniper bot deployed and running (see DEPLOYMENT.md)
- [ ] Server with 2GB+ RAM and 20GB+ disk space
- [ ] Root or sudo access
- [ ] Metrics endpoint accessible: `http://localhost:3000/metrics`

### Recommended

- [ ] Domain name for Grafana (e.g., `monitoring.yourdomain.com`)
- [ ] SSL certificate (Let's Encrypt)
- [ ] Slack workspace (for alerts)
- [ ] PagerDuty account (for on-call alerts) - optional

---

## Prometheus Setup

### Option 1: Docker Deployment (Recommended)

#### Step 1: Create Docker Compose File

Create `monitoring/docker-compose.yml`:

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    restart: unless-stopped
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=15d'
      - '--web.console.libraries=/etc/prometheus/console_libraries'
      - '--web.console.templates=/etc/prometheus/consoles'
      - '--web.enable-lifecycle'
    ports:
      - '9090:9090'
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - ./prometheus-alerts.yml:/etc/prometheus/alerts.yml
      - prometheus-data:/prometheus
    networks:
      - monitoring

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: unless-stopped
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=CHANGE_ME_STRONG_PASSWORD
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_SERVER_ROOT_URL=http://localhost:3000
      - GF_INSTALL_PLUGINS=grafana-piechart-panel
    ports:
      - '3001:3000'
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning
      - ./grafana/dashboards:/var/lib/grafana/dashboards
    networks:
      - monitoring
    depends_on:
      - prometheus

  alertmanager:
    image: prom/alertmanager:latest
    container_name: alertmanager
    restart: unless-stopped
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
      - '--storage.path=/alertmanager'
    ports:
      - '9093:9093'
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml
      - alertmanager-data:/alertmanager
    networks:
      - monitoring

volumes:
  prometheus-data:
    driver: local
  grafana-data:
    driver: local
  alertmanager-data:
    driver: local

networks:
  monitoring:
    driver: bridge
```

#### Step 2: Create Prometheus Configuration

Create `monitoring/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: 'production'
    environment: 'mainnet'

# Alertmanager configuration
alerting:
  alertmanagers:
    - static_configs:
        - targets:
            - alertmanager:9093

# Load alert rules
rule_files:
  - 'alerts.yml'

# Scrape configurations
scrape_configs:
  # Sniper bot metrics
  - job_name: 'sniper-bot'
    static_configs:
      - targets:
          - 'host.docker.internal:3000'  # Application metrics endpoint
    metrics_path: '/metrics'
    scrape_interval: 15s

  # Prometheus self-monitoring
  - job_name: 'prometheus'
    static_configs:
      - targets:
          - 'localhost:9090'

  # Node Exporter (system metrics) - optional
  - job_name: 'node-exporter'
    static_configs:
      - targets:
          - 'host.docker.internal:9100'
```

#### Step 3: Start Monitoring Stack

```bash
# Navigate to monitoring directory
cd monitoring

# Start all services
docker-compose up -d

# Verify services are running
docker-compose ps

# Expected output:
# prometheus    running   0.0.0.0:9090->9090/tcp
# grafana       running   0.0.0.0:3001->3000/tcp
# alertmanager  running   0.0.0.0:9093->9093/tcp

# Check logs
docker-compose logs -f prometheus
docker-compose logs -f grafana
```

#### Step 4: Verify Prometheus

1. **Access Prometheus UI**: http://your-server:9090

2. **Verify targets**:
   - Click "Status" → "Targets"
   - All targets should show "UP" status
   - If "DOWN", check firewall and application metrics endpoint

3. **Test a query**:
   - Go to "Graph" tab
   - Enter: `up{job="sniper-bot"}`
   - Click "Execute"
   - Should return "1" (application is up)

---

### Option 2: Bare Metal Deployment

#### Step 1: Install Prometheus

```bash
# Create prometheus user
sudo useradd --no-create-home --shell /bin/false prometheus

# Download Prometheus (latest version)
cd /tmp
wget https://github.com/prometheus/prometheus/releases/download/v2.48.0/prometheus-2.48.0.linux-amd64.tar.gz
tar -xvf prometheus-2.48.0.linux-amd64.tar.gz
cd prometheus-2.48.0.linux-amd64

# Copy binaries
sudo cp prometheus /usr/local/bin/
sudo cp promtool /usr/local/bin/

# Create directories
sudo mkdir /etc/prometheus
sudo mkdir /var/lib/prometheus

# Copy configuration files
sudo cp -r consoles /etc/prometheus/
sudo cp -r console_libraries /etc/prometheus/

# Set ownership
sudo chown -R prometheus:prometheus /etc/prometheus
sudo chown -R prometheus:prometheus /var/lib/prometheus
sudo chown prometheus:prometheus /usr/local/bin/prometheus
sudo chown prometheus:prometheus /usr/local/bin/promtool
```

#### Step 2: Create Prometheus Configuration

Create `/etc/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets:
            - 'localhost:9093'

rule_files:
  - 'alerts.yml'

scrape_configs:
  - job_name: 'sniper-bot'
    static_configs:
      - targets:
          - 'localhost:3000'
    metrics_path: '/metrics'

  - job_name: 'prometheus'
    static_configs:
      - targets:
          - 'localhost:9090'
```

#### Step 3: Create Systemd Service

Create `/etc/systemd/system/prometheus.service`:

```ini
[Unit]
Description=Prometheus
Wants=network-online.target
After=network-online.target

[Service]
User=prometheus
Group=prometheus
Type=simple
ExecStart=/usr/local/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus/ \
  --storage.tsdb.retention.time=15d \
  --web.console.templates=/etc/prometheus/consoles \
  --web.console.libraries=/etc/prometheus/console_libraries \
  --web.enable-lifecycle

Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

#### Step 4: Start Prometheus

```bash
# Reload systemd
sudo systemctl daemon-reload

# Start Prometheus
sudo systemctl start prometheus

# Enable on boot
sudo systemctl enable prometheus

# Check status
sudo systemctl status prometheus

# View logs
sudo journalctl -u prometheus -f
```

---

## Grafana Setup

### Option 1: Docker (Already done in Prometheus Docker Compose)

Grafana is already running from the `docker-compose.yml` above.

**Access:**
- URL: http://your-server:3001
- Username: `admin`
- Password: `CHANGE_ME_STRONG_PASSWORD` (set in docker-compose.yml)

---

### Option 2: Bare Metal

#### Step 1: Install Grafana

```bash
# Add Grafana APT repository
sudo apt-get install -y software-properties-common
sudo add-apt-repository "deb https://packages.grafana.com/oss/deb stable main"
wget -q -O - https://packages.grafana.com/gpg.key | sudo apt-key add -

# Update and install
sudo apt-get update
sudo apt-get install -y grafana

# Start Grafana
sudo systemctl start grafana-server
sudo systemctl enable grafana-server

# Check status
sudo systemctl status grafana-server
```

#### Step 2: Configure Grafana

Edit `/etc/grafana/grafana.ini`:

```ini
[server]
http_port = 3001
domain = monitoring.yourdomain.com
root_url = https://monitoring.yourdomain.com

[security]
admin_user = admin
admin_password = CHANGE_ME_STRONG_PASSWORD
allow_sign_up = false

[auth.anonymous]
enabled = false
```

Restart Grafana:
```bash
sudo systemctl restart grafana-server
```

#### Step 3: Access Grafana

1. **Open browser**: http://your-server:3001

2. **Login**:
   - Username: `admin`
   - Password: (from grafana.ini)

3. **Change admin password** (first login):
   - Click "Skip" or set a strong password

---

## Dashboard Configuration

### Step 1: Add Prometheus Data Source

1. **Login to Grafana**: http://your-server:3001

2. **Navigate to Data Sources**:
   - Click gear icon (⚙️) → "Data sources"
   - Click "Add data source"

3. **Select Prometheus**:
   - Click "Prometheus"

4. **Configure connection**:
   - **Name:** `Prometheus`
   - **URL:** `http://prometheus:9090` (Docker) or `http://localhost:9090` (bare metal)
   - **Access:** `Server` (default)
   - **Scrape interval:** `15s`

5. **Save & Test**:
   - Click "Save & Test"
   - Should show green checkmark: "Data source is working"

---

### Step 2: Import Dashboards

The sniper bot includes 5 pre-built Grafana dashboards:

1. **Performance Dashboard** (`grafana/dashboards/performance.json`)
2. **Detection Dashboard** (`grafana/dashboards/detection.json`)
3. **Sniper Dashboard** (`grafana/dashboards/sniper.json`)
4. **Positions Dashboard** (`grafana/dashboards/positions.json`)
5. **Health Dashboard** (`grafana/dashboards/health.json`)

#### Import Method 1: Grafana UI

1. **Navigate to Import**:
   - Click "+" icon → "Import"

2. **Upload JSON**:
   - Click "Upload JSON file"
   - Select `grafana/dashboards/performance.json` from project directory
   - Click "Load"

3. **Configure**:
   - **Name:** Keep default or customize
   - **Folder:** Select "General" or create new folder "Sniper Bot"
   - **UID:** Keep auto-generated
   - **Prometheus data source:** Select "Prometheus"

4. **Import**:
   - Click "Import"
   - Dashboard should load with live data

5. **Repeat** for all 5 dashboards

#### Import Method 2: API (Automated)

```bash
# Script to import all dashboards
for dashboard in grafana/dashboards/*.json; do
  curl -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_GRAFANA_API_KEY" \
    -d @"$dashboard" \
    http://localhost:3001/api/dashboards/db
done
```

---

### Step 3: Configure Dashboard Provisioning (Optional)

For automated dashboard loading on Grafana start:

Create `/etc/grafana/provisioning/dashboards/sniper-bot.yml`:

```yaml
apiVersion: 1

providers:
  - name: 'Sniper Bot'
    orgId: 1
    folder: 'Sniper Bot'
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
```

Copy dashboards:
```bash
sudo mkdir -p /var/lib/grafana/dashboards
sudo cp grafana/dashboards/*.json /var/lib/grafana/dashboards/
sudo chown -R grafana:grafana /var/lib/grafana/dashboards
sudo systemctl restart grafana-server
```

---

## Alertmanager Setup

### Step 1: Create Alertmanager Configuration

Create `monitoring/alertmanager.yml`:

```yaml
global:
  resolve_timeout: 5m
  slack_api_url: 'https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK'

# Alert routing tree
route:
  receiver: 'default'
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h

  # Child routes
  routes:
    # P1 Critical alerts → PagerDuty + Slack
    - match:
        severity: critical
      receiver: 'pagerduty-critical'
      continue: true

    # P2 High alerts → Slack
    - match:
        severity: warning
      receiver: 'slack-warnings'

    # P3/P4 Low priority → Email
    - match:
        severity: info
      receiver: 'email-notifications'

# Receivers
receivers:
  # Default receiver
  - name: 'default'
    slack_configs:
      - channel: '#alerts'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
        send_resolved: true

  # PagerDuty for critical alerts
  - name: 'pagerduty-critical'
    pagerduty_configs:
      - service_key: 'YOUR_PAGERDUTY_SERVICE_KEY'
        description: '{{ .GroupLabels.alertname }}'

  # Slack for warnings
  - name: 'slack-warnings'
    slack_configs:
      - channel: '#sniper-bot-alerts'
        title: '⚠️ {{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
        color: 'warning'
        send_resolved: true

  # Email for low priority
  - name: 'email-notifications'
    email_configs:
      - to: 'devops@example.com'
        from: 'alertmanager@example.com'
        smarthost: 'smtp.gmail.com:587'
        auth_username: 'alertmanager@example.com'
        auth_password: 'YOUR_EMAIL_PASSWORD'
        headers:
          Subject: 'Sniper Bot Alert: {{ .GroupLabels.alertname }}'

# Inhibition rules (prevent alert spam)
inhibit_rules:
  # If critical alert fires, suppress warning alerts
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname', 'cluster', 'service']
```

---

## Alert Rules

### Create Alert Rules File

Create `monitoring/prometheus-alerts.yml`:

```yaml
groups:
  - name: sniper_bot_critical
    interval: 30s
    rules:
      # P1: Application down
      - alert: ApplicationDown
        expr: up{job="sniper-bot"} == 0
        for: 1m
        labels:
          severity: critical
          priority: P1
        annotations:
          summary: "Sniper Bot application is down"
          description: "Application has been down for more than 1 minute"

      # P1: All RPC endpoints failing
      - alert: AllRPCEndpointsDown
        expr: sum(circuit_breaker_state{name=~"rpc_.*"}) == count(circuit_breaker_state{name=~"rpc_.*"})
        for: 5m
        labels:
          severity: critical
          priority: P1
        annotations:
          summary: "All RPC endpoints are down"
          description: "Circuit breakers are OPEN for all RPC endpoints"

  - name: sniper_bot_high
    interval: 30s
    rules:
      # P2: Circuit breaker open too long
      - alert: CircuitBreakerOpenTooLong
        expr: circuit_breaker_state{name="rpc_pool"} == 1
        for: 5m
        labels:
          severity: warning
          priority: P2
        annotations:
          summary: "Circuit breaker {{ $labels.name }} has been OPEN for >5 minutes"
          description: "RPC/API failures detected. Check logs for root cause."

      # P2: High unlock failure rate (brute-force attack?)
      - alert: HighUnlockFailureRate
        expr: rate(wallet_unlock_failures_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
          priority: P2
        annotations:
          summary: "High unlock failure rate detected (>6 failures/minute)"
          description: "Possible brute-force attack. Review rate limiter logs."

      # P2: High execution latency
      - alert: HighExecutionLatency
        expr: histogram_quantile(0.95, sum(rate(benchmark_duration_ms_bucket{component="EXECUTION"}[5m])) by (le)) > 2500
        for: 5m
        labels:
          severity: warning
          priority: P2
        annotations:
          summary: "Trade execution latency critical"
          description: "p95 latency is {{ $value }}ms (target: <1500ms)"

      # P2: High memory usage
      - alert: HighMemoryUsage
        expr: benchmark_memory_mb > 800
        for: 5m
        labels:
          severity: warning
          priority: P2
        annotations:
          summary: "Memory usage approaching limit"
          description: "Peak memory is {{ $value }}MB (limit: 500MB)"

  - name: sniper_bot_medium
    interval: 30s
    rules:
      # P3: High RPC latency
      - alert: HighRPCLatency
        expr: histogram_quantile(0.99, rate(rpc_request_duration_seconds_bucket[5m])) > 5
        for: 5m
        labels:
          severity: info
          priority: P3
        annotations:
          summary: "RPC P99 latency >5 seconds"
          description: "RPC endpoint {{ $labels.endpoint }} is slow. Consider failover."

      # P3: Low success rate
      - alert: LowSuccessRate
        expr: benchmark_success_rate < 70
        for: 10m
        labels:
          severity: info
          priority: P3
        annotations:
          summary: "{{ $labels.component }} success rate below 70%"
          description: "Success rate is {{ $value }}%"

      # P3: Geyser disconnected (if enabled)
      - alert: GeyserDisconnected
        expr: geyser_connection_status == 0
        for: 5m
        labels:
          severity: info
          priority: P3
        annotations:
          summary: "Geyser connection lost"
          description: "Geyser has been disconnected for 5 minutes. Fallback to WebSocket."
```

---

## Testing & Validation

### Test 1: Verify Metrics Endpoint

```bash
# Check if metrics endpoint is accessible
curl http://localhost:3000/metrics

# Expected output (partial):
# circuit_breaker_state{name="rpc_pool"} 0
# rpc_request_duration_seconds_bucket{endpoint="helius",le="1"} 150
# active_sessions 5
# wallet_unlock_failures_total 0
```

---

### Test 2: Verify Prometheus Scraping

1. **Open Prometheus UI**: http://your-server:9090

2. **Check targets**:
   - Navigate to "Status" → "Targets"
   - `sniper-bot` target should show "UP" status

3. **Query metrics**:
   - Go to "Graph" tab
   - Enter: `circuit_breaker_state{name="rpc_pool"}`
   - Click "Execute"
   - Should return current circuit breaker state (0 = CLOSED)

---

### Test 3: Verify Grafana Dashboards

1. **Open Grafana**: http://your-server:3001

2. **Navigate to dashboard**:
   - Click "Dashboards" icon (left sidebar)
   - Select "Performance" dashboard

3. **Verify panels**:
   - All panels should display data (not "No data")
   - Latency graph shows recent data points
   - Success rate gauge shows percentage
   - Resource usage graphs show current values

---

### Test 4: Test Alert Rules

#### Manually trigger an alert:

```bash
# Stop application to trigger "ApplicationDown" alert
sudo systemctl stop sniper-bot

# Wait 1 minute for alert to fire
sleep 60

# Check Alertmanager
curl http://localhost:9093/api/v2/alerts

# Expected: Alert with status "firing"

# Check Prometheus alerts
# Open: http://your-server:9090/alerts
# Should show "ApplicationDown" alert in red "FIRING" state

# Restart application to resolve alert
sudo systemctl start sniper-bot

# Wait for alert to resolve (5 minutes)
```

#### Check alert notification:

- **Slack**: Alert should appear in configured channel
- **PagerDuty**: Incident should be created
- **Email**: Email should be sent

---

## Production Best Practices

### 1. Data Retention

```yaml
# prometheus.yml
global:
  external_labels:
    cluster: 'production'

storage:
  tsdb:
    retention.time: 15d  # Keep 15 days of data
    retention.size: 10GB # Or max 10GB
```

**Recommendation:**
- Local Prometheus: 15 days
- Long-term storage: Use Thanos or Cortex (optional)

---

### 2. High Availability

**Option 1: Multiple Prometheus Instances**

Deploy 2+ Prometheus servers scraping the same targets:

```yaml
# prometheus-1.yml
global:
  external_labels:
    replica: 'prometheus-1'

# prometheus-2.yml
global:
  external_labels:
    replica: 'prometheus-2'
```

Grafana can query both instances for redundancy.

**Option 2: Prometheus Federation**

Central Prometheus aggregates data from multiple instances:

```yaml
# central-prometheus.yml
scrape_configs:
  - job_name: 'federate'
    honor_labels: true
    metrics_path: '/federate'
    params:
      'match[]':
        - '{job="sniper-bot"}'
    static_configs:
      - targets:
          - 'prometheus-1:9090'
          - 'prometheus-2:9090'
```

---

### 3. Security

```bash
# Enable basic auth for Prometheus
sudo apt-get install apache2-utils
sudo htpasswd -c /etc/prometheus/.htpasswd admin

# Edit prometheus.service
ExecStart=/usr/local/bin/prometheus \
  --web.config.file=/etc/prometheus/web.yml \
  ...

# Create /etc/prometheus/web.yml
basic_auth_users:
  admin: $2y$05$... # bcrypt hash from htpasswd

# Restart Prometheus
sudo systemctl restart prometheus
```

---

### 4. SSL/TLS

Use Nginx reverse proxy:

```nginx
# /etc/nginx/sites-available/monitoring
server {
    listen 443 ssl http2;
    server_name monitoring.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/monitoring.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/monitoring.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

# Prometheus
server {
    listen 443 ssl http2;
    server_name prometheus.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/prometheus.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/prometheus.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:9090;
        proxy_set_header Host $host;
    }
}
```

---

### 5. Backup

```bash
# Backup Prometheus data
tar -czf prometheus-backup-$(date +%Y%m%d).tar.gz /var/lib/prometheus

# Backup Grafana dashboards
curl -H "Authorization: Bearer YOUR_GRAFANA_API_KEY" \
  http://localhost:3001/api/search?type=dash-db | \
  jq -r '.[].uid' | \
  xargs -I{} curl -H "Authorization: Bearer YOUR_GRAFANA_API_KEY" \
  http://localhost:3001/api/dashboards/uid/{} > grafana-dashboards-backup-$(date +%Y%m%d).json

# Schedule daily backups
sudo crontab -e
# Add: 0 2 * * * /usr/local/bin/backup-monitoring.sh
```

---

## Troubleshooting

### Issue 1: Prometheus Not Scraping Metrics

**Symptoms:**
- Target shows "DOWN" status in Prometheus UI
- Queries return "No data"

**Diagnosis:**
```bash
# Check if metrics endpoint is accessible
curl http://localhost:3000/metrics

# Check Prometheus logs
docker-compose logs prometheus  # Docker
sudo journalctl -u prometheus -f  # Bare metal

# Check firewall
sudo ufw status
```

**Solution:**
```bash
# If firewall blocking:
sudo ufw allow from PROMETHEUS_IP to any port 3000 proto tcp

# If application not exposing metrics:
# Verify src/utils/metrics.ts is configured correctly

# Restart Prometheus
docker-compose restart prometheus  # Docker
sudo systemctl restart prometheus  # Bare metal
```

---

### Issue 2: Grafana Dashboards Show "No Data"

**Symptoms:**
- Dashboards load but all panels show "No data"
- Prometheus queries work in Prometheus UI

**Diagnosis:**
```bash
# Check Grafana data source configuration
curl -u admin:password http://localhost:3001/api/datasources

# Test data source
curl -u admin:password \
  -H "Content-Type: application/json" \
  -X POST http://localhost:3001/api/datasources/proxy/1/api/v1/query \
  -d '{"query":"up"}'
```

**Solution:**
1. **Verify data source URL**:
   - Grafana → Configuration → Data Sources → Prometheus
   - URL should be `http://prometheus:9090` (Docker) or `http://localhost:9090` (bare metal)

2. **Check permissions**:
   - Grafana must have network access to Prometheus

3. **Re-import dashboards**:
   - Delete old dashboard
   - Re-import from JSON file

---

### Issue 3: Alerts Not Firing

**Symptoms:**
- Alert rules configured but never fire
- Alertmanager shows no alerts

**Diagnosis:**
```bash
# Check if Prometheus is loading alert rules
curl http://localhost:9090/api/v1/rules

# Check Alertmanager logs
docker-compose logs alertmanager  # Docker
sudo journalctl -u alertmanager -f  # Bare metal
```

**Solution:**
```bash
# Verify alert rules syntax
promtool check rules /etc/prometheus/alerts.yml

# Reload Prometheus configuration
curl -X POST http://localhost:9090/-/reload

# Manually trigger alert for testing
sudo systemctl stop sniper-bot
# Wait 1 minute, check http://localhost:9090/alerts
```

---

### Issue 4: Alertmanager Not Sending Notifications

**Symptoms:**
- Alerts firing in Prometheus
- No Slack/email notifications received

**Diagnosis:**
```bash
# Check Alertmanager configuration
amtool check-config /etc/alertmanager/alertmanager.yml

# Check Alertmanager logs
docker-compose logs alertmanager | grep -i error

# Test Slack webhook manually
curl -X POST \
  -H 'Content-type: application/json' \
  --data '{"text":"Test alert from Alertmanager"}' \
  YOUR_SLACK_WEBHOOK_URL
```

**Solution:**
1. **Verify webhook URL**:
   - Test Slack webhook manually (see above)
   - Check for typos in alertmanager.yml

2. **Check Alertmanager routing**:
   - Open http://localhost:9093
   - Navigate to "Status" → check receiver configuration

3. **Reload Alertmanager**:
   ```bash
   docker-compose restart alertmanager
   # OR
   sudo systemctl restart alertmanager
   ```

---

## Quick Start Checklist

- [ ] 1. Install Prometheus (Docker or bare metal) - 15 min
- [ ] 2. Configure prometheus.yml - 5 min
- [ ] 3. Start Prometheus and verify targets - 5 min
- [ ] 4. Install Grafana - 10 min
- [ ] 5. Add Prometheus data source in Grafana - 2 min
- [ ] 6. Import 5 dashboards - 10 min
- [ ] 7. Configure Alertmanager - 10 min
- [ ] 8. Create alert rules (prometheus-alerts.yml) - 15 min
- [ ] 9. Test alerts by stopping application - 5 min
- [ ] 10. Configure Slack/PagerDuty notifications - 10 min

**Total Time:** ~90 minutes

---

## Support & Resources

### Official Documentation

- **Prometheus:** https://prometheus.io/docs/
- **Grafana:** https://grafana.com/docs/
- **Alertmanager:** https://prometheus.io/docs/alerting/latest/alertmanager/

### Community

- **Prometheus Community:** https://prometheus.io/community/
- **Grafana Community:** https://community.grafana.com/

### Internal Documentation

- **Production Checklist:** [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md)
- **Deployment Guide:** [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Runbook:** [RUNBOOK.md](./RUNBOOK.md)

---

**Document Version:** 1.0.0
**Maintained By:** DevOps Team
**Review Schedule:** Monthly
**Next Review:** ___________
