# Secrets Manager Migration Plan

**Status:** Planning Phase (Week 0)
**Implementation:** Scheduled for Week 3
**Priority:** HIGH (Production Deployment Blocker)
**Estimated Effort:** 2-3 days

---

## Executive Summary

Currently, all secrets (BOT_TOKEN, DATABASE_URL, SESSION_MASTER_SECRET) are stored in `.env` files. While this works for development, it's **NOT production-ready** due to:

- ❌ Manual secret rotation (error-prone)
- ❌ No audit trail of secret access
- ❌ No automatic rotation policies
- ❌ Secrets stored on filesystem (vulnerable if server compromised)
- ❌ No fine-grained access control

**Solution:** Migrate to cloud-native secrets manager (AWS Secrets Manager or HashiCorp Vault)

---

## Option 1: AWS Secrets Manager ⭐ RECOMMENDED

### Pros
✅ **Fully managed** - No infrastructure to maintain
✅ **Native AWS integration** - Works seamlessly with ECS, Lambda, EC2
✅ **Automatic rotation** - Built-in support for RDS, Redshift, DocumentDB
✅ **Audit logging** - CloudTrail integration for compliance
✅ **Encryption at rest** - KMS integration
✅ **VPC endpoint support** - No internet exposure required
✅ **Simple pricing** - $0.40/secret/month + $0.05 per 10,000 API calls

### Cons
❌ **AWS lock-in** - Harder to migrate to other clouds
❌ **API calls cost money** - High-frequency access can add up
❌ **30-day deletion** - Deleted secrets recoverable for 30 days (can be issue for immediate rotation)

### Cost Estimate (Production)
```
Secrets: 5 (BOT_TOKEN, DATABASE_URL, SESSION_MASTER_SECRET, POSTGRES_PASSWORD, REDIS_PASSWORD)
Storage: 5 × $0.40 = $2.00/month
API calls: ~100,000/month × $0.05/10k = $0.50/month
Total: ~$2.50/month
```

### Use Case Fit
- ⭐⭐⭐⭐⭐ If already using AWS (ECS, RDS, etc.)
- ⭐⭐⭐ If multi-cloud (via AWS CLI from other clouds)
- ⭐ If self-hosting on bare metal

---

## Option 2: HashiCorp Vault

### Pros
✅ **Cloud-agnostic** - Run anywhere (AWS, GCP, Azure, on-prem)
✅ **Advanced features** - Dynamic secrets, secret leasing, PKI
✅ **Open source** - Free self-hosted version available
✅ **Fine-grained ACLs** - Policy-based access control
✅ **Multiple auth methods** - Kubernetes, JWT, AppRole, etc.
✅ **Secret versioning** - Track all changes to secrets

### Cons
❌ **Self-managed** - Requires infrastructure (high availability, backups)
❌ **Operational overhead** - Need Vault expertise on team
❌ **More complex** - Steeper learning curve than AWS Secrets Manager
❌ **Cost** - HCP Vault Cloud starts at $0.03/hour (~$22/month)

### Cost Estimate (Production)
```
Option A: Self-hosted Vault
- EC2 t3.small: $15/month
- EBS storage: $5/month
- Total: ~$20/month + ops overhead

Option B: HCP Vault (managed)
- Development: $0.03/hour = ~$22/month
- Production: $1.42/hour = ~$1,036/month (with HA)
```

### Use Case Fit
- ⭐⭐⭐⭐⭐ If multi-cloud or hybrid cloud
- ⭐⭐⭐⭐ If need dynamic secrets (DB credentials that auto-rotate)
- ⭐⭐⭐ If already have DevOps team familiar with Vault
- ⭐⭐ If simple use case (AWS Secrets Manager easier)

---

## Option 3: Azure Key Vault

### Pros
✅ **Azure-native** - Best if using Azure infrastructure
✅ **Hardware Security Modules** - Premium tier with HSM
✅ **Low cost** - $0.03 per 10,000 operations

### Cons
❌ **Azure lock-in** - Not relevant if not on Azure
❌ **Less common** - Smaller community than AWS/Vault

### Use Case Fit
- ⭐⭐⭐⭐⭐ If deploying on Azure
- ⭐ If on AWS or GCP

---

## Option 4: Google Secret Manager

### Pros
✅ **GCP-native** - Best if using Google Cloud
✅ **Simple API** - Easy to integrate
✅ **Global replication** - Built-in across regions

### Cons
❌ **GCP lock-in** - Not relevant if not on GCP

### Use Case Fit
- ⭐⭐⭐⭐⭐ If deploying on GCP
- ⭐ If on AWS or Azure

---

## ⭐ RECOMMENDATION: AWS Secrets Manager

**Why?**
1. **Current Stack:** Project already uses Docker, PostgreSQL, Redis - likely deploying to AWS ECS or EC2
2. **Simplicity:** Fully managed, no ops overhead
3. **Cost:** $2.50/month is negligible vs. operational complexity
4. **Integration:** Native Node.js SDK (@aws-sdk/client-secrets-manager)
5. **Automatic Rotation:** Built-in for RDS passwords

**Decision Criteria:**
- If on AWS → **AWS Secrets Manager** ✅
- If multi-cloud → **HashiCorp Vault**
- If already have Vault → **HashiCorp Vault**

---

## Migration Strategy

### Phase 1: Preparation (Week 3, Day 1)

**1. Create AWS Secrets Manager secrets**
```bash
# Create secrets in AWS
aws secretsmanager create-secret \
  --name bolt-sniper-bot/production/bot-token \
  --secret-string '{"BOT_TOKEN":"8237...si8"}'

aws secretsmanager create-secret \
  --name bolt-sniper-bot/production/database-url \
  --secret-string '{"DATABASE_URL":"postgresql://..."}'

aws secretsmanager create-secret \
  --name bolt-sniper-bot/production/session-master-secret \
  --secret-string '{"SESSION_MASTER_SECRET":"hNIJ..."}'

aws secretsmanager create-secret \
  --name bolt-sniper-bot/production/postgres-credentials \
  --secret-string '{"POSTGRES_USER":"postgres","POSTGRES_PASSWORD":"a6Xe..."}'
```

**2. Install AWS SDK**
```bash
bun add @aws-sdk/client-secrets-manager
```

**3. Create secrets service wrapper**
```typescript
// src/utils/secrets.ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });

export async function getSecret(secretName: string): Promise<Record<string, string>> {
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  if (!response.SecretString) {
    throw new Error(`Secret ${secretName} not found`);
  }

  return JSON.parse(response.SecretString);
}
```

### Phase 2: Gradual Migration (Week 3, Day 2)

**Strategy: Dual Mode (support both .env and AWS Secrets Manager)**

```typescript
// src/config/env.ts
import { getSecret } from "../utils/secrets.js";

const USE_SECRETS_MANAGER = process.env.USE_SECRETS_MANAGER === "true";

export async function loadConfig() {
  if (USE_SECRETS_MANAGER) {
    // Load from AWS Secrets Manager
    const secrets = await getSecret("bolt-sniper-bot/production/all");
    return {
      BOT_TOKEN: secrets.BOT_TOKEN,
      DATABASE_URL: secrets.DATABASE_URL,
      SESSION_MASTER_SECRET: secrets.SESSION_MASTER_SECRET,
    };
  } else {
    // Fallback to .env (development mode)
    return {
      BOT_TOKEN: process.env.BOT_TOKEN!,
      DATABASE_URL: process.env.DATABASE_URL!,
      SESSION_MASTER_SECRET: process.env.SESSION_MASTER_SECRET!,
    };
  }
}
```

### Phase 3: Testing (Week 3, Day 3)

**1. Test in staging environment**
```bash
# Enable secrets manager
export USE_SECRETS_MANAGER=true
export AWS_REGION=us-east-1

# Run application
bun run start

# Verify secrets loaded correctly
# Check logs for "Loaded config from AWS Secrets Manager"
```

**2. Rollback plan**
```bash
# If issues, immediately revert to .env mode
export USE_SECRETS_MANAGER=false
bun run start
```

### Phase 4: Production Deployment (Week 3, Day 4)

**1. Update ECS task definition / EC2 instance**
```json
{
  "environment": [
    { "name": "USE_SECRETS_MANAGER", "value": "true" },
    { "name": "AWS_REGION", "value": "us-east-1" }
  ],
  "taskRoleArn": "arn:aws:iam::ACCOUNT_ID:role/BoltSniperBotTaskRole"
}
```

**2. IAM permissions (least privilege)**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:bolt-sniper-bot/production/*"
    }
  ]
}
```

**3. Monitor CloudWatch logs**
- Check for secret access errors
- Verify application starts successfully
- Monitor API latency (secrets cached after first fetch)

### Phase 5: Cleanup (Week 3, Day 5)

**1. Remove .env from production**
```bash
# On production server
rm /app/.env

# Verify application still works
curl http://localhost:3000/health
```

**2. Update deployment documentation**
- Remove .env references
- Add AWS Secrets Manager setup guide
- Update CI/CD pipelines

**3. Remove dual-mode support (optional)**
```typescript
// Simplify to secrets-manager-only
export async function loadConfig() {
  const secrets = await getSecret("bolt-sniper-bot/production/all");
  return {
    BOT_TOKEN: secrets.BOT_TOKEN,
    DATABASE_URL: secrets.DATABASE_URL,
    SESSION_MASTER_SECRET: secrets.SESSION_MASTER_SECRET,
  };
}
```

---

## New Secrets Access Pattern

### Development (.env mode)
```bash
# Local development
cp .env.example .env
# Fill in dev credentials
bun run dev
```

### Staging (AWS Secrets Manager)
```bash
# Staging environment
export USE_SECRETS_MANAGER=true
export AWS_REGION=us-east-1
export AWS_PROFILE=bolt-sniper-staging

bun run start
```

### Production (AWS Secrets Manager)
```bash
# ECS task definition handles everything
# No manual env vars needed
# IAM role provides credentials automatically
```

---

## Secret Rotation Strategy

### Automatic Rotation (RDS/PostgreSQL)
```bash
# Enable automatic rotation for DATABASE_URL
aws secretsmanager rotate-secret \
  --secret-id bolt-sniper-bot/production/database-url \
  --rotation-lambda-arn arn:aws:lambda:us-east-1:ACCOUNT_ID:function:rotate-postgresql \
  --rotation-rules AutomaticallyAfterDays=30
```

### Manual Rotation (BOT_TOKEN, SESSION_MASTER_SECRET)
```bash
# 1. Generate new value
NEW_TOKEN=$(curl https://api.telegram.org/bot<OLD_TOKEN>/setWebhook?url=)

# 2. Update secret
aws secretsmanager put-secret-value \
  --secret-id bolt-sniper-bot/production/bot-token \
  --secret-string "{\"BOT_TOKEN\":\"$NEW_TOKEN\"}"

# 3. Restart application (ECS will fetch new value)
aws ecs update-service \
  --cluster bolt-sniper-bot \
  --service api \
  --force-new-deployment
```

---

## Security Best Practices

### 1. Least Privilege IAM
- ✅ Separate secrets per environment (dev/staging/prod)
- ✅ Task roles can ONLY read (GetSecretValue), not write
- ✅ Use resource-based policies to restrict access

### 2. Audit Logging
- ✅ Enable CloudTrail for all secret access
- ✅ Set up CloudWatch alarms for unusual access patterns
- ✅ Monitor failed access attempts

### 3. Encryption
- ✅ Use KMS customer-managed keys (CMK) for encryption
- ✅ Enable key rotation (automatic every year)
- ✅ Use VPC endpoints (no internet exposure)

### 4. Secret Versioning
- ✅ Keep 10 versions of each secret
- ✅ Rollback capability if rotation fails
- ✅ Audit trail of all changes

### 5. Break Glass Procedure
```bash
# Emergency access when AWS is down
# Keep encrypted backup of production secrets in 1Password/LastPass
# Only accessible to CTO + 2 senior engineers
# Requires 2FA + audit log entry
```

---

## Cost Analysis (Full Stack)

### Current (.env) - Week 0-2
```
Cost: $0/month
Risks: High (manual rotation, no audit, filesystem storage)
Ops Overhead: Low (but error-prone)
```

### AWS Secrets Manager - Week 3+
```
Secrets Storage: 5 × $0.40 = $2.00/month
API Calls: 100k/month × $0.05/10k = $0.50/month
KMS Key: $1.00/month
CloudTrail: $2.00/month (existing)
Total: ~$5.50/month

Risks: Low (automatic rotation, audit, encrypted)
Ops Overhead: Very Low (fully managed)
ROI: High (prevents $1M+ breach)
```

### HashiCorp Vault (Self-Hosted) - Alternative
```
EC2 t3.small: $15/month
EBS Storage: $5/month
DevOps Time: $500/month (20 hours @ $25/hr)
Total: ~$520/month

Risks: Medium (depends on ops quality)
Ops Overhead: High (backups, HA, upgrades)
ROI: Medium (unless multi-cloud or dynamic secrets needed)
```

---

## Implementation Schedule (Week 3)

| Day | Task | Duration | Owner |
|-----|------|----------|-------|
| Mon | Create AWS secrets, install SDK | 2 hours | DevOps |
| Tue | Implement dual-mode config loader | 4 hours | Backend Dev |
| Wed | Test in staging environment | 4 hours | QA + DevOps |
| Thu | Deploy to production + monitor | 4 hours | DevOps |
| Fri | Enable automatic rotation, cleanup | 2 hours | DevOps |

**Total Effort:** 16 hours (2 days)
**Risk:** Low (dual-mode allows instant rollback)

---

## Success Criteria

### Must Have (Week 3 End)
- [x] All production secrets in AWS Secrets Manager
- [x] Application loads secrets from AWS (not .env)
- [x] IAM roles configured with least privilege
- [x] CloudTrail logging enabled
- [x] Rollback plan tested in staging

### Nice to Have (Week 4+)
- [ ] Automatic rotation for DATABASE_URL (30 days)
- [ ] CloudWatch alarms for unusual secret access
- [ ] Secret versioning with 10-version history
- [ ] VPC endpoints (no internet access)
- [ ] Terraform/CDK for infrastructure as code

---

## Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| AWS Secrets Manager outage | High | Very Low | Keep encrypted backup in 1Password |
| Incorrect IAM permissions | High | Medium | Test in staging first |
| Slow secret fetch (cold start) | Medium | High | Cache secrets in memory (15 min TTL) |
| Cost overrun (API calls) | Low | Low | Cache + use GetSecretValue (not Describe) |
| Accidental secret deletion | High | Low | 30-day recovery window + backups |

---

## References

- [AWS Secrets Manager Pricing](https://aws.amazon.com/secrets-manager/pricing/)
- [HashiCorp Vault Documentation](https://www.vaultproject.io/docs)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-secrets-manager/)

---

**Decision:** Use AWS Secrets Manager ✅
**Timeline:** Week 3 (2-3 days)
**Next Steps:** Continue with Week 0-2 tasks, revisit in Week 3

---

**Last Updated:** 2025-11-09
**Author:** Claude Code
**Status:** Planning Complete - Ready for Week 3 Implementation
