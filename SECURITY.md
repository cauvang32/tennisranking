# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| < Latest| :x:                |

## Reporting a Vulnerability

We take the security of the Tennis Ranking System seriously. If you discover a security vulnerability, please follow these steps:

### 1. **Do Not** Open a Public Issue
Please do not report security vulnerabilities through public GitHub issues.

### 2. Report Privately
Send an email to the repository maintainers with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### 3. Response Timeline
- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Fix Timeline**: Depends on severity
  - Critical: 1-7 days
  - High: 7-14 days
  - Medium: 14-30 days
  - Low: 30-90 days

## Security Measures

This project implements multiple security measures:

### Application Security
- ✅ **Helmet.js**: Security headers (CSP, XSS protection, etc.)
- ✅ **CORS**: Cross-origin resource sharing protection
- ✅ **Rate Limiting**: Prevents brute force and DoS attacks
- ✅ **CSRF Protection**: Token-based CSRF prevention
- ✅ **Input Validation**: Express-validator for all user inputs
- ✅ **Authentication**: JWT token-based authentication
- ✅ **Password Security**: Bcrypt hashing with salt
- ✅ **Session Security**: Secure cookie configuration
- ✅ **SQL Injection Prevention**: Parameterized queries with PostgreSQL

### Infrastructure Security
- ✅ **Environment Variables**: Sensitive data in .env files
- ✅ **HTTPS Ready**: Secure cookie configuration for production
- ✅ **Docker Security**: Non-root user in containers
- ✅ **Dependencies**: Regular security updates via Dependabot

### Monitoring & Scanning
- ✅ **Dependabot**: Weekly dependency security updates
- ✅ **CodeQL**: Automated code security analysis
- ✅ **NPM Audit**: Daily vulnerability scans
- ✅ **Access Logging**: Request logging for security monitoring

## Known Vulnerabilities

See [SECURITY_VULNERABILITIES.md](./SECURITY_VULNERABILITIES.md) for:
- Current vulnerability status
- Fixed vulnerabilities
- Known issues with no fix available
- Mitigation strategies

## Security Best Practices

When contributing to this project:

1. **Never commit secrets**: Use environment variables
2. **Validate all inputs**: Use express-validator
3. **Sanitize data**: Prevent XSS and injection attacks
4. **Use parameterized queries**: Prevent SQL injection
5. **Keep dependencies updated**: Monitor Dependabot PRs
6. **Test security changes**: Ensure fixes don't break functionality
7. **Follow principle of least privilege**: Minimal permissions
8. **Review security advisories**: Stay informed about vulnerabilities

## Security Checklist for PRs

Before submitting a PR, ensure:

- [ ] No secrets or credentials in code
- [ ] All user inputs are validated
- [ ] No SQL queries without parameterization
- [ ] Dependencies are up-to-date
- [ ] `npm audit` shows no new vulnerabilities
- [ ] Security tests pass (if applicable)
- [ ] Authentication/authorization is properly implemented
- [ ] Error messages don't leak sensitive information

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Express.js Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [GitHub Security Advisories](https://github.com/advisories)
- [npm Security](https://docs.npmjs.com/about-security-audits)

## Contact

For security-related questions or concerns, please contact the repository maintainers.

---

Last Updated: October 24, 2025
