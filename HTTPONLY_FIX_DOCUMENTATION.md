# HttpOnly Cookie Security Fix - Documentation

## Issue Description
The `sharedCookieDefaults` object in `server.js` did NOT include the `httpOnly: true` flag by default. This was a security vulnerability because cookies without the httpOnly flag can be accessed by client-side JavaScript, making them vulnerable to XSS (Cross-Site Scripting) attacks.

## Vulnerability Details
- **Risk Level**: HIGH
- **Attack Vector**: Cross-Site Scripting (XSS)
- **Impact**: Attackers could steal authentication tokens and session cookies
- **OWASP**: A03:2021 – Injection (XSS)

## Before Fix
```javascript
const sharedCookieDefaults = {
  secure: secureCookiesEnabled,
  sameSite: sameSitePolicy
}
```

**Problem**: No `httpOnly` flag in default configuration
- Cookies could be read by JavaScript: `document.cookie`
- Individual cookies needed explicit `httpOnly: true`
- Risk of developer forgetting to add httpOnly flag

## After Fix
```javascript
const sharedCookieDefaults = {
  httpOnly: true,        // ✅ Added for security
  secure: secureCookiesEnabled,
  sameSite: sameSitePolicy
}
```

**Solution**: HttpOnly is now enforced by default
- All cookies are protected from JavaScript access
- Consistent security across all cookies
- Defense in depth approach

## HTTP Headers Comparison

### Before (when explicit httpOnly was missing):
```
Set-Cookie: someCookie=value; Path=/; SameSite=Lax
```
❌ No HttpOnly flag - vulnerable to XSS

### After (with default httpOnly):
```
Set-Cookie: authToken=...; HttpOnly; SameSite=Lax; Secure; Path=/
Set-Cookie: csrfSessionId=...; HttpOnly; SameSite=Lax; Secure; Path=/
```
✅ HttpOnly flag present - protected from XSS

## Code Changes Summary

### 1. Added httpOnly to defaults (server.js:46-49)
```diff
const sharedCookieDefaults = {
+  httpOnly: true,
  secure: secureCookiesEnabled,
  sameSite: sameSitePolicy
}
```

### 2. Removed redundant httpOnly flags
Since httpOnly is now in defaults, removed explicit settings from:
- Login endpoint (authToken cookie)
- CSRF endpoints (csrfSessionId cookie)
- Cookie clearing functions

## Testing

### Automated Test
Created `test-httponly-cookies.js` to verify:
- ✅ Login endpoint sets httpOnly cookies
- ✅ CSRF endpoint sets httpOnly cookies
- ✅ All cookies have httpOnly flag in headers

### Manual Verification
```bash
curl -v -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"dev_admin_password"}'
```

Output shows:
```
Set-Cookie: authToken=...; HttpOnly; ...
Set-Cookie: csrfSessionId=...; HttpOnly; ...
```

### Security Scan
- ✅ CodeQL: 0 vulnerabilities found
- ✅ All security tests passing

## Impact

### Security Benefits
1. **XSS Protection**: Cookies cannot be accessed via JavaScript
2. **Defense in Depth**: Multiple layers of cookie security
3. **OWASP Compliance**: Meets security best practices
4. **Future-proof**: All new cookies automatically secure

### Performance Impact
- **None**: HttpOnly is a flag, no performance cost
- **Compatibility**: Works with all modern browsers

### Breaking Changes
- **None**: All existing code continues to work
- **Backward Compatible**: Explicit httpOnly settings still work

## Security Checklist
- [x] HttpOnly flag added to default configuration
- [x] All cookies tested for httpOnly flag
- [x] Security scan completed (CodeQL)
- [x] Manual verification with curl
- [x] Automated test created for regression prevention
- [x] Documentation updated

## References
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [MDN: Set-Cookie HttpOnly](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie#httponly)
- [CWE-1004: Sensitive Cookie Without 'HttpOnly' Flag](https://cwe.mitre.org/data/definitions/1004.html)

## Conclusion
This fix ensures all cookies in the Tennis Ranking System are protected from XSS attacks by enforcing the httpOnly flag by default. The change is minimal, backward compatible, and significantly improves the security posture of the application.
