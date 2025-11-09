# Pre-Commit Hook Documentation

## Overview

The pre-commit hook automatically runs before every `git commit` to prevent accidentally committing sensitive files like `.env` to the repository.

## What It Does

✅ **Blocks commits containing:**
- `.env` files (all variants: `.env`, `.env.local`, `.env.production`, etc.)
- Private keys (`*.private.key`, `*.pem`)
- Any other sensitive credential files

✅ **Provides helpful error messages:**
- Clear explanation of why the commit was blocked
- Step-by-step instructions to fix the issue
- Command-line examples

## Installation

The hook is already installed in `.git/hooks/pre-commit` and is **automatically active** for this repository.

### Manual Installation (if needed)

If the hook is missing or not working:

```bash
# Copy the hook from the repository template (if available)
cp scripts/pre-commit .git/hooks/pre-commit

# Make it executable
chmod +x .git/hooks/pre-commit

# Test it
git add -f .env
git commit -m "test"  # Should be blocked
git reset HEAD .env   # Unstage
```

## How It Works

1. **Pre-commit trigger**: Git runs `.git/hooks/pre-commit` before creating a commit
2. **File scanning**: Hook scans all staged files (`git diff --cached --name-only`)
3. **Pattern matching**: Checks filenames against blocked patterns using regex
4. **Action**:
   - If sensitive files found → Exit with code 1 (blocks commit)
   - If no sensitive files → Exit with code 0 (allows commit)

## Blocked Patterns

| Pattern | Description | Example |
|---------|-------------|---------|
| `^\.env$` | Main .env file | `.env` |
| `^\.env\.local$` | Local environment | `.env.local` |
| `^\.env\.production$` | Production env | `.env.production` |
| `^\.env\.development$` | Development env | `.env.development` |
| `.*private.*\.key$` | Private keys | `wallet.private.key` |
| `.*\.pem$` | PEM certificates | `cert.pem` |

## Example Output

### When .env is blocked:

```
[Pre-commit Hook] Checking for sensitive files...

╔════════════════════════════════════════════════════════════╗
║  ⚠️  COMMIT BLOCKED - SENSITIVE FILES DETECTED  ⚠️        ║
╚════════════════════════════════════════════════════════════╝

The following sensitive files are staged for commit:

  ✗ .env

Why is this blocked?
  • .env files contain secrets (API keys, passwords, tokens)
  • Committing secrets can lead to security breaches
  • Secrets should NEVER be in git history

How to fix:
  1. Unstage the file:
     git reset HEAD .env

  2. Verify .gitignore includes .env:
     grep -q "^\.env$" .gitignore && echo "✓ Already ignored" || echo ".env" >> .gitignore

Commit aborted.
```

### When commit is allowed:

```
[Pre-commit Hook] Checking for sensitive files...
✓ No sensitive files detected. Proceeding with commit...
```

## Bypassing the Hook (NOT RECOMMENDED)

⚠️ **WARNING**: Only use this if you absolutely know what you're doing!

```bash
# Skip the pre-commit hook (DANGEROUS!)
git commit --no-verify -m "your message"
```

**Why you should NEVER bypass:**
- Secrets in git history are **permanent** (even after deletion)
- GitHub/GitLab automatically scan for exposed credentials
- Attackers can access your entire infrastructure
- Rotating all secrets is time-consuming and expensive

## Troubleshooting

### Hook not running

**Check if hook exists:**
```bash
ls -la .git/hooks/pre-commit
```

**Check if executable:**
```bash
chmod +x .git/hooks/pre-commit
```

### Hook runs but doesn't block .env

**Verify .env is staged:**
```bash
git diff --cached --name-only | grep .env
```

**Test hook manually:**
```bash
.git/hooks/pre-commit
echo $?  # Should be 0 (success) or 1 (blocked)
```

### False positives

If the hook blocks a legitimate file:

1. Review the blocked patterns in `.git/hooks/pre-commit`
2. Remove the pattern that's causing issues
3. Report the issue to the development team

## Best Practices

1. **Never commit secrets** - Use environment variables or secret managers
2. **Use `.env.example`** - Document required env vars without exposing values
3. **Rotate secrets immediately** - If you accidentally commit a secret:
   - Revoke/rotate the exposed secret ASAP
   - Remove from git history: `git filter-branch` (see hook output)
   - Force push to remote: `git push --force`
   - Notify the team about the force push

4. **Test in development** - Always test with dummy values first
5. **Use different secrets per environment** - dev/staging/prod should have different credentials

## Team Onboarding

When a new developer joins:

1. Clone the repository: `git clone ...`
2. Copy environment template: `cp .env.example .env`
3. Fill in their credentials (get from team lead / secret manager)
4. Verify hook works: `git add -f .env && git commit -m "test"` (should be blocked)
5. Unstage: `git reset HEAD .env`

## Security Contacts

If you discover a security vulnerability or accidentally commit secrets:

1. **Immediately** notify the security team
2. **Do NOT** try to fix it by committing again
3. Follow the incident response procedure

---

**Last Updated**: 2025-11-09
**Author**: Claude Code
**Version**: 1.0
