# Security Vulnerabilities Report

This document tracks known security vulnerabilities in the project and their status.

## Current Status

Last Updated: 2025-10-24

### Fixed Vulnerabilities ✅

#### 1. Vite (6.3.5 → 6.4.1)
**Fixed:** October 24, 2025

**Vulnerabilities:**
- **GHSA-g4jq-h2w9-997c**: Vite middleware may serve files starting with the same name with the public directory
  - Severity: Low
  - Type: CWE-22, CWE-200, CWE-284
- **GHSA-jqfw-vq24-v9c3**: Vite's `server.fs` settings were not applied to HTML files
  - Severity: Low
  - Type: CWE-23, CWE-200, CWE-284
- **GHSA-93m4-6634-74q7**: vite allows server.fs.deny bypass via backslash on Windows
  - Severity: Moderate
  - Type: CWE-22

**Resolution:** Updated Vite from 6.3.5 to 6.4.1 via `npm audit fix`

### Known Vulnerabilities (No Fix Available) ⚠️

#### 1. Validator.js (express-validator dependency)
**Status:** No fix available as of October 24, 2025

**Vulnerability:**
- **GHSA-9965-vmph-33xx**: validator.js has a URL validation bypass vulnerability in its isURL function
  - Severity: Moderate
  - CVSS Score: 6.1 (CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N)
  - Type: CWE-79 (Cross-site Scripting)
  - Affected Versions: <= 13.15.15
  - Currently installed: 13.15.15

**Impact on This Project:** **LOW**

This vulnerability specifically affects the `isURL()` function in validator.js. After thorough code analysis:
- ✅ **This application does NOT use the `isURL()` function**
- ✅ Only uses safe validators: `isLength()`, `isInt()`, `isISO8601()`, `isBoolean()`, `isString()`
- ✅ No user input is validated as URLs anywhere in the application
- ✅ The vulnerable function is present in the dependency but never called

**Mitigation Strategy:**
1. Continuous monitoring of npm audit reports
2. Will update to patched version immediately when available
3. Code review policy: Do not introduce `isURL()` usage until vulnerability is patched
4. Alternative: If URL validation is needed in the future, use Node.js built-in `URL` class instead

**Monitoring:**
- Weekly Dependabot scans enabled
- npm audit checks in CI/CD pipeline recommended

## Automated Security Scanning

### Dependabot Configuration
Dependabot is now properly configured in `.github/dependabot.yml` to:
- Track npm dependencies weekly
- Automatically create pull requests for security updates
- Group minor and patch updates together
- Limit to 10 open pull requests at a time

### GitHub Actions Workflows
Two security workflows have been added:

1. **CodeQL Security Analysis** (`.github/workflows/codeql.yml`)
   - Runs on push/PR to main branches
   - Weekly scheduled scan (Mondays at 2:00 AM)
   - Uses security-extended queries for thorough analysis
   - Automatically detects security vulnerabilities in JavaScript code

2. **Security Audit** (`.github/workflows/security-audit.yml`)
   - Runs npm audit on push/PR to main branches
   - Daily scheduled audit (3:00 AM)
   - Checks both all and production dependencies
   - Generates and uploads audit reports as artifacts

## Recommendations

1. **Regular Audits**: Run `npm audit` before each deployment
2. **Stay Updated**: Keep dependencies up-to-date with weekly Dependabot scans
3. **Security Scanning**: Enable CodeQL code scanning in GitHub Actions
4. **Review PRs**: Carefully review all Dependabot security update PRs
5. **Test Updates**: Always test dependency updates in a staging environment before production

## Additional Security Measures

This project already implements several security best practices:
- ✅ Helmet.js for security headers
- ✅ CORS protection with domain whitelisting
- ✅ Rate limiting on all endpoints
- ✅ CSRF protection
- ✅ Input validation with express-validator
- ✅ JWT token authentication
- ✅ Bcrypt password hashing
- ✅ Secure session management
- ✅ Cookie security settings
- ✅ SQL injection prevention (PostgreSQL parameterized queries)

## References

- [GitHub Advisory Database](https://github.com/advisories)
- [npm audit documentation](https://docs.npmjs.com/cli/v8/commands/npm-audit)
- [Dependabot documentation](https://docs.github.com/en/code-security/dependabot)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
